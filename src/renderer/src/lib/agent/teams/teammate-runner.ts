import { nanoid } from 'nanoid'
import { toolRegistry } from '../tool-registry'
import { teamEvents } from './events'
import { useTeamStore } from '../../../stores/team-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { useProviderStore } from '../../../stores/provider-store'
import { ensureProviderAuthReady } from '../../auth/provider-auth'
import { useAgentStore } from '../../../stores/agent-store'
import { ipcClient } from '../../ipc/ipc-client'
import { MessageQueue } from '../types'
import type { AgentLoopConfig } from '../types'
import type { UnifiedMessage, ProviderConfig, TokenUsage } from '../../api/types'
import type { TeamRuntimeTaskStatus } from '../../../../../shared/team-runtime-types'
import type { TeamMessage, TeamTask } from './types'
import { buildRuntimeCompression } from '../context-compression-runtime'
import { subAgentRegistry } from '../sub-agents/registry'
import { resolveSubAgentTools } from '../sub-agents/resolve-tools'
import { runSharedAgentRuntime } from '../shared-runtime'
import { appendTeamRuntimeMessage, updateTeamRuntimeManifest, updateTeamRuntimeMember } from './runtime-client'
import { requestTeammatePermission, stopWorkerPermissionPoller } from './permission-bridge'
import { requestPlanApproval, stopWorkerPlanApprovalPoller } from './plan-approval-bridge'
import { buildTeammateAddendum } from './prompts'
import { startWorkerInboxPoller, stopWorkerInboxPoller } from './worker-inbox'

// --- AbortController registry for individual teammates ---
const teammateAbortControllers = new Map<string, AbortController>()

// --- Graceful shutdown registry ---
// When a shutdown_request is received, the teammate finishes its current
// iteration and then stops — instead of hard aborting mid-tool-call.
const teammateShutdownRequested = new Set<string>()
// 0 => unlimited iterations (teammate stops only on completion/shutdown/error/abort)
const DEFAULT_TEAMMATE_MAX_ITERATIONS = 0

async function syncRuntimeMemberState(
  memberId: string,
  patch: Parameters<typeof updateTeamRuntimeMember>[0]['patch']
): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team?.name) return

  try {
    await updateTeamRuntimeMember({
      teamName: team.name,
      memberId,
      patch
    })
  } catch (error) {
    console.error('[TeamRuntime] Failed to sync teammate runtime member state:', error)
  }
}

async function syncRuntimeTaskState(
  taskId: string,
  patch: Partial<{ status: TeamRuntimeTaskStatus; owner: string | null; report: string }>
): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team?.name) return

  try {
    await updateTeamRuntimeManifest({
      teamName: team.name,
      patch: {
        tasks: team.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
      }
    })
  } catch (error) {
    console.error('[TeamRuntime] Failed to sync teammate runtime task state:', error)
  }
}

/**
 * Request graceful shutdown: teammate finishes current iteration then stops.
 */
export function requestTeammateShutdown(memberId: string): void {
  teammateShutdownRequested.add(memberId)
}

/**
 * Abort a running teammate by member ID (hard stop).
 * Returns true if the teammate was found and aborted.
 */
export function abortTeammate(memberId: string): boolean {
  const ac = teammateAbortControllers.get(memberId)
  if (ac) {
    ac.abort()
    teammateAbortControllers.delete(memberId)
    teammateShutdownRequested.delete(memberId)
    return true
  }
  return false
}

/** Abort all running teammates (e.g. on TeamDelete). */
export function abortAllTeammates(): void {
  for (const [id, ac] of teammateAbortControllers) {
    ac.abort()
    teammateAbortControllers.delete(id)
  }
  teammateShutdownRequested.clear()
}

/** Check if a teammate is still running. */
export function isTeammateRunning(memberId: string): boolean {
  return teammateAbortControllers.has(memberId)
}

interface RunTeammateOptions {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
  agentName: string | null
  workingFolder?: string
}

/**
 * Start an independent agent loop for a teammate.
 * Runs in background (fire-and-forget). Updates team-store via teamEvents.
 *
 * Each teammate executes a single assigned task then stops.
 * The framework-level scheduler (in create-tool.ts) handles
 * auto-dispatching the next pending task to a new teammate
 * when a concurrency slot frees up.
 *
 * On completion (or error), the teammate automatically sends a summary
 * message to the lead so the lead's context includes the result without
 * needing to poll. The lead is auto-notified via SendMessage.
 */
export async function runTeammate(options: RunTeammateOptions): Promise<void> {
  const { memberId, memberName, model, agentName, workingFolder } = options
  let { prompt, taskId } = options

  const abortController = new AbortController()
  teammateAbortControllers.set(memberId, abortController)

  // Exclude team management tools from teammate (only lead should manage team).
  // TaskCreate is excluded because teammates should not create new tasks.
  // Note: Task tool is kept but run_in_background is guarded inside executeBackgroundTeammate.
  const LEAD_ONLY_TOOLS = new Set(['TeamCreate', 'TeamDelete', 'TaskCreate'])
  const baseToolDefs = toolRegistry
    .getDefinitions()
    .filter((tool) => !LEAD_ONLY_TOOLS.has(tool.name))
  const agentDefinition = agentName ? subAgentRegistry.get(agentName) : undefined
  const toolDefs = agentDefinition
    ? resolveSubAgentTools(agentDefinition, baseToolDefs).tools
    : baseToolDefs

  // Message queue: receives messages from lead/other teammates and injects
  // them into the agent loop at iteration boundaries (between turns).
  const messageQueue = new MessageQueue()

  // Listen for in-process team events targeting this teammate
  const unsubMessages = teamEvents.on((event) => {
    if (event.type !== 'team_message') return
    const msg = event.message
    const isForMe = msg.to === memberName || msg.to === 'all'
    if (!isForMe) return
    if (msg.from === memberName) return

    if (msg.type === 'shutdown_request') {
      teammateShutdownRequested.add(memberId)
    } else if (msg.type !== 'permission_response' && msg.type !== 'plan_approval_response') {
      messageQueue.push({
        id: nanoid(),
        role: 'user',
        content: `[Team message from ${msg.from}]: ${msg.content}`,
        createdAt: msg.timestamp
      })
    }
  })

  startWorkerInboxPoller({
    memberId,
    memberName,
    onMessage: (content, createdAt) => {
      messageQueue.push({
        id: nanoid(),
        role: 'user',
        content,
        createdAt
      })
    }
  })

  let totalIterations = 0
  let totalToolCalls = 0
  let tasksCompleted = 0
  let lastStreamingText = ''
  let fullOutput = ''
  let endReason: 'completed' | 'aborted' | 'error' | 'shutdown' = 'completed'

  try {
    if (!taskId) {
      const initialTask = findNextClaimableTask()
      if (initialTask) {
        taskId = initialTask.id
        prompt = `Work on the following task:\n**Subject:** ${initialTask.subject}\n**Description:** ${initialTask.description}\n\nAdditional context from lead:\n${prompt}`
        teamEvents.emit({
          type: 'team_task_update',
          taskId: initialTask.id,
          patch: { status: 'in_progress', owner: memberName }
        })
        teamEvents.emit({
          type: 'team_member_update',
          memberId,
          patch: { currentTaskId: initialTask.id }
        })
        await syncRuntimeMemberState(memberId, {
          currentTaskId: initialTask.id,
          status: 'working'
        })
      }
    }

    const result = await runSingleTaskLoop({
      memberId,
      memberName,
      prompt,
      taskId,
      model,
      workingFolder,
      abortController,
      toolDefs,
      messageQueue,
      agentName
    })

    totalIterations = result.iterations
    totalToolCalls = result.toolCalls
    lastStreamingText = result.lastStreamingText
    fullOutput = result.fullOutput
    if (result.taskCompleted) tasksCompleted++
    if (result.reason === 'aborted') endReason = 'aborted'
    else if (result.reason === 'shutdown') endReason = 'shutdown'
    else if (result.reason === 'error') endReason = 'error'

    const completedAt = Date.now()
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { status: 'stopped', completedAt }
    })
    await syncRuntimeMemberState(memberId, {
      status: 'stopped',
      completedAt,
      isActive: false
    })
  } catch (error) {
    endReason = 'error'
    if (!abortController.signal.aborted) {
      console.error(`[Teammate ${memberName}] Error:`, error)
    }
    const completedAt = Date.now()
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { status: 'stopped', completedAt }
    })
    await syncRuntimeMemberState(memberId, {
      status: 'stopped',
      completedAt,
      isActive: false
    })
  } finally {
    teammateAbortControllers.delete(memberId)
    teammateShutdownRequested.delete(memberId)
    unsubMessages()
    stopWorkerPermissionPoller(memberName)
    stopWorkerPlanApprovalPoller(memberName)
    stopWorkerInboxPoller(memberId)

    if (endReason !== 'aborted') {
      emitCompletionMessage(memberName, endReason, {
        totalIterations,
        totalToolCalls,
        tasksCompleted,
        lastStreamingText,
        fullOutput,
        taskId
      })
    }
  }
}

// ── Single task execution ──────────────────────────────────────────

interface SingleTaskResult {
  iterations: number
  toolCalls: number
  lastStreamingText: string
  fullOutput: string
  taskCompleted: boolean
  reason: 'completed' | 'max_iterations' | 'aborted' | 'shutdown' | 'error'
  usage: TokenUsage
}

async function runSingleTaskLoop(opts: {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
  agentName: string | null
  workingFolder?: string
  abortController: AbortController
  toolDefs: ReturnType<typeof toolRegistry.getDefinitions>
  messageQueue?: MessageQueue
}): Promise<SingleTaskResult> {
  const {
    memberId,
    memberName,
    prompt,
    taskId,
    model,
    agentName,
    workingFolder,
    abortController,
    toolDefs,
    messageQueue
  } = opts

  const settings = useSettingsStore.getState()
  const providerState = useProviderStore.getState()
  const activeProviderId = providerState.activeProviderId
  if (activeProviderId) {
    const ready = await ensureProviderAuthReady(activeProviderId)
    if (!ready) {
      throw new Error('Provider authentication required. Please sign in.')
    }
  }

  const activeConfig = providerState.getActiveProviderConfig()
  const effectiveModel =
    model && model !== 'default' ? model : (activeConfig?.model ?? settings.model)
  const effectiveMaxTokens = useProviderStore
    .getState()
    .getEffectiveMaxTokens(settings.maxTokens, effectiveModel)
  const providerConfig: ProviderConfig = activeConfig
    ? {
        ...activeConfig,
        model: effectiveModel,
        maxTokens: effectiveMaxTokens,
        temperature: settings.temperature
      }
    : {
        type: settings.provider,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || undefined,
        model: effectiveModel,
        maxTokens: effectiveMaxTokens,
        temperature: settings.temperature
      }

  if (toolDefs.length === 0) {
    throw new Error(
      agentName
        ? `No tools available for teammate agent "${agentName}".`
        : 'No tools available for teammate.'
    )
  }

  const team = useTeamStore.getState().activeTeam
  const taskInfo = taskId && team ? team.tasks.find((task) => task.id === taskId) : null
  const agentDefinition = agentName ? subAgentRegistry.get(agentName) : undefined
  const effectivePrompt = agentDefinition?.initialPrompt
    ? `${agentDefinition.initialPrompt}\n\n${prompt}`
    : prompt

  const coordinationPrompt = buildTeammateAddendum({
    memberName,
    teamName: team?.name ?? 'team',
    prompt: effectivePrompt,
    task: taskInfo
      ? { id: taskInfo.id, subject: taskInfo.subject, description: taskInfo.description }
      : null,
    workingFolder,
    language: settings.language,
    permissionMode: team?.permissionMode
  })
  const systemPrompt = agentDefinition
    ? `${agentDefinition.systemPrompt}\n\n${coordinationPrompt}`
    : coordinationPrompt
  providerConfig.systemPrompt = systemPrompt

  const compression = buildRuntimeCompression(providerConfig, abortController.signal)

  const loopConfig: AgentLoopConfig = {
    maxIterations: agentDefinition?.maxTurns ?? DEFAULT_TEAMMATE_MAX_ITERATIONS,
    provider: providerConfig,
    tools: toolDefs,
    systemPrompt,
    workingFolder,
    signal: abortController.signal,
    messageQueue,
    ...(compression ? { contextCompression: compression } : {})
  }

  const initialMessages: UnifiedMessage[] = []

  if (team?.permissionMode === 'plan') {
    const planPrompt = buildPlanRequestText(taskInfo ?? null, effectivePrompt)
    const planRuntime = await runSharedAgentRuntime({
      initialMessages: [
        {
          id: nanoid(),
          role: 'user',
          content: planPrompt,
          createdAt: Date.now()
        }
      ],
      loopConfig: {
        ...loopConfig,
        maxIterations: 1
      },
      toolContext: {
        workingFolder,
        signal: abortController.signal,
        ipc: ipcClient,
        callerAgent: 'teammate'
      },
      isReadOnlyTool: () => true
    })

    const planText = planRuntime.finalOutput.trim()
    const approval = await requestPlanApproval({
      memberName,
      plan: planText,
      taskId
    })

    if (!approval.approved) {
      const rejectedOutput = approval.feedback
        ? `${planText}\n\nLead feedback: ${approval.feedback}`
        : planText
      return {
        iterations: planRuntime.iterations,
        toolCalls: planRuntime.toolCallCount,
        lastStreamingText: rejectedOutput,
        fullOutput: rejectedOutput,
        taskCompleted: false,
        reason: 'completed',
        usage: planRuntime.usage
      }
    }

    initialMessages.push({
      id: nanoid(),
      role: 'user',
      content: `Lead approved your plan. Proceed with execution. ${approval.feedback ?? ''}`.trim(),
      createdAt: Date.now()
    })
  }

  initialMessages.push({
    id: nanoid(),
    role: 'user',
    content: effectivePrompt,
    createdAt: Date.now()
  })

  teamEvents.emit({
    type: 'team_member_update',
    memberId,
    patch: { status: 'working', iteration: 0 }
  })
  await syncRuntimeMemberState(memberId, {
    status: 'working',
    currentTaskId: taskId
  })

  let streamingText = ''
  let taskCompleted = false

  const STREAM_THROTTLE_MS = 200
  let streamDirty = false
  let streamTimer: ReturnType<typeof setTimeout> | null = null

  const flushStreamingText = (): void => {
    if (streamTimer) {
      clearTimeout(streamTimer)
      streamTimer = null
    }
    if (!streamDirty) return
    streamDirty = false
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { streamingText }
    })
  }

  const runtime = await runSharedAgentRuntime({
    initialMessages,
    loopConfig,
    toolContext: {
      workingFolder,
      signal: abortController.signal,
      ipc: ipcClient,
      callerAgent: 'teammate'
    },
    isReadOnlyTool: (toolName) => READ_ONLY_TOOLS.has(toolName),
    onApprovalNeeded: async (toolCall) => {
      const autoApprove = useSettingsStore.getState().autoApprove
      if (autoApprove) return true
      const approved = useAgentStore.getState().approvedToolNames
      if (approved.includes(toolCall.name)) return true
      const result = await requestTeammatePermission({
        memberName,
        toolCall: {
          ...toolCall,
          status: 'pending_approval',
          requiresApproval: true
        }
      })
      if (result) useAgentStore.getState().addApprovedTool(toolCall.name)
      return result
    },
    hooks: {
      beforeHandleEvent: ({ event }) => {
        if (event.type !== 'iteration_start') return

        if (teammateShutdownRequested.has(memberId)) {
          return { stop: true, reason: 'shutdown' }
        }

        if (!taskId) return undefined
        const currentTeam = useTeamStore.getState().activeTeam
        const currentTask = currentTeam?.tasks.find((task) => task.id === taskId)
        if (currentTask?.status === 'completed') {
          taskCompleted = true
          return { stop: true, reason: 'completed' }
        }
        return undefined
      },
      afterHandleEvent: async ({ event, state }) => {
        switch (event.type) {
          case 'iteration_start':
            streamingText = ''
            flushStreamingText()
            teamEvents.emit({
              type: 'team_member_update',
              memberId,
              patch: { iteration: state.iteration, status: 'working', streamingText: '' }
            })
            await syncRuntimeMemberState(memberId, {
              status: 'working',
              currentTaskId: taskId
            })
            break

          case 'text_delta':
            streamingText += event.text
            streamDirty = true
            if (!streamTimer) {
              streamTimer = setTimeout(flushStreamingText, STREAM_THROTTLE_MS)
            }
            break

          case 'tool_call_approval_needed': {
            const willAutoApprove =
              useSettingsStore.getState().autoApprove ||
              useAgentStore.getState().approvedToolNames.includes(event.toolCall.name)
            if (!willAutoApprove) {
              useAgentStore.getState().addToolCall(event.toolCall)
            }
            break
          }

          case 'tool_call_start':
          case 'tool_call_result':
            flushStreamingText()
            teamEvents.emit({
              type: 'team_member_update',
              memberId,
              patch: { toolCalls: [...state.toolCalls] }
            })
            break

          case 'message_end':
            if (event.usage) {
              teamEvents.emit({
                type: 'team_member_update',
                memberId,
                patch: { usage: { ...state.usage } }
              })
              await syncRuntimeMemberState(memberId, {
                status: 'working',
                currentTaskId: taskId
              })
            }
            break

          case 'loop_end':
            flushStreamingText()
            if ((event.reason === 'completed' || event.reason === 'max_iterations') && taskId) {
              teamEvents.emit({
                type: 'team_task_update',
                taskId,
                patch: { status: 'completed' }
              })
              await syncRuntimeTaskState(taskId, { status: 'completed' })
              taskCompleted = true
            }
            if (taskCompleted) {
              await syncRuntimeMemberState(memberId, {
                currentTaskId: null
              })
            }
            break
        }
      }
    }
  })

  if (streamTimer) {
    clearTimeout(streamTimer)
    streamTimer = null
  }
  flushStreamingText()

  const resolvedOutput = runtime.finalOutput

  if (taskId && resolvedOutput) {
    const currentTask = useTeamStore.getState().activeTeam?.tasks.find((task) => task.id === taskId)
    if (!currentTask?.report?.trim()) {
      teamEvents.emit({
        type: 'team_task_update',
        taskId,
        patch: { report: resolvedOutput }
      })
    }
  }

  return {
    iterations: runtime.iterations,
    toolCalls: runtime.toolCallCount,
    lastStreamingText: streamingText,
    fullOutput: resolvedOutput,
    taskCompleted,
    reason: runtime.reason,
    usage: runtime.usage
  }
}

// ── Auto-claim: find next unassigned, unblocked pending task ──────

export function findNextClaimableTask(): TeamTask | null {
  const team = useTeamStore.getState().activeTeam
  if (!team) return null

  const completedTaskIds = new Set(
    team.tasks.filter((task) => task.status === 'completed').map((task) => task.id)
  )

  for (const task of team.tasks) {
    if (task.status !== 'pending') continue
    if (task.owner) continue

    const allDepsCompleted = task.dependsOn.every((depId) => completedTaskIds.has(depId))
    if (!allDepsCompleted) continue

    return task
  }

  return null
}

// ── Auto-notify: send completion summary to lead ─────────────────

const MAX_REPORT_LENGTH = 4000

function emitCompletionMessage(
  memberName: string,
  endReason: string,
  stats: {
    totalIterations: number
    totalToolCalls: number
    tasksCompleted: number
    lastStreamingText: string
    fullOutput: string
    taskId: string | null
  }
): void {
  const team = useTeamStore.getState().activeTeam
  if (!team) return

  const header = [
    `**${memberName}** finished (${endReason}).`,
    `Iterations: ${stats.totalIterations}, Tool calls: ${stats.totalToolCalls}, Tasks completed: ${stats.tasksCompleted}.`
  ].join(' ')

  const task = stats.taskId ? team.tasks.find((item) => item.id === stats.taskId) : null
  const reportText = task?.report || stats.fullOutput || stats.lastStreamingText
  let report = ''
  if (reportText) {
    if (reportText.length <= MAX_REPORT_LENGTH) {
      report = `\n\n## Report\n${reportText}`
    } else {
      report = `\n\n## Report\n${reportText.slice(-MAX_REPORT_LENGTH)}\n\n*(report truncated, showing last ${MAX_REPORT_LENGTH} chars of ${reportText.length} total)*`
    }
  }

  const content = header + report

  const message: TeamMessage = {
    id: nanoid(8),
    from: memberName,
    to: 'lead',
    type: 'message',
    content,
    summary: `${memberName} finished (${endReason}): ${stats.tasksCompleted} tasks, ${stats.totalToolCalls} tool calls`,
    timestamp: Date.now()
  }

  void appendTeamRuntimeMessage({
    teamName: team.name,
    message
  }).catch((error) => {
    console.error('[TeamRuntime] Failed to append completion message:', error)
  })

  teamEvents.emit({ type: 'team_message', message })
}

// --- Helpers ---

const READ_ONLY_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'TaskList', 'TaskGet', 'TeamStatus'])

function buildPlanRequestText(task: TeamTask | null, prompt: string): string {
  const subject = task?.subject ?? 'Assigned Task'
  const description = task?.description ?? prompt
  return [
    `Create a short execution plan for the task below.`,
    `Task Subject: ${subject}`,
    `Task Description: ${description}`,
    '',
    'Requirements:',
    '- Keep it concise and implementation-focused.',
    '- Mention key files or subsystems you expect to touch.',
    '- Mention verification approach.',
    '- End with a single sentence stating you are waiting for lead approval.'
  ].join('\n')
}
