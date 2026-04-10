import { nanoid } from 'nanoid'
import type { ToolHandler, ToolContext } from '../../tools/tool-types'
import type { SubAgentDefinition, SubAgentEvent } from './types'
import type { ToolCallState } from '../types'
import { runSubAgent } from './runner'
import { subAgentEvents } from './events'
import { subAgentRegistry } from './registry'
import type { ProviderConfig, TokenUsage, ToolResultContent } from '../../api/types'
import type { TeamRuntimeTaskStatus } from '../../../../../shared/team-runtime-types'
import { encodeStructuredToolResult, encodeToolError } from '../../tools/tool-result-format'
import { useAgentStore } from '../../../stores/agent-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { ConcurrencyLimiter } from '../concurrency-limiter'
import { teamEvents } from '../teams/events'
import { useTeamStore } from '../../../stores/team-store'
import { runTeammate, findNextClaimableTask } from '../teams/teammate-runner'
import { spawnIsolatedTeamWorker } from '../teams/backend-client'
import { updateTeamRuntimeManifest, updateTeamRuntimeMember } from '../teams/runtime-client'
import type { TeamMember } from '../teams/types'

const subAgentLimiter = new ConcurrencyLimiter(2)

/**
 * Tracks the immediately-previous synchronous Task invocation per session so
 * we can block back-to-back identical sub-agent calls. Some parent models will
 * happily re-invoke the same sub-agent with the same prompt over and over
 * after it returns a report, wasting tokens and confusing the UI. Blocking
 * the second identical call and returning the previous report forces the
 * parent to move on.
 */
interface LastTaskInvocation {
  key: string
  output: string
  toolUseId: string
}
const lastTaskInvocationBySession = new Map<string, LastTaskInvocation>()

function normalizeTaskPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

function buildTaskDedupKey(input: Record<string, unknown>): string {
  const subType = String(input.subagent_type ?? '')
  const prompt =
    normalizeTaskPrompt(input.prompt) ||
    normalizeTaskPrompt(input.query) ||
    normalizeTaskPrompt(input.task) ||
    normalizeTaskPrompt(input.target)
  return `${subType}::${prompt}`
}

export function clearLastTaskInvocation(sessionId: string | undefined | null): void {
  if (!sessionId) return
  lastTaskInvocationBySession.delete(sessionId)
}

export interface SubAgentMeta {
  iterations: number
  elapsed: number
  usage: TokenUsage
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    status: string
    output?: string
    error?: string
    startedAt?: number
    completedAt?: number
  }>
}

const META_PREFIX = '<!--subagent-meta:'
const META_SUFFIX = '-->\n'

export function parseSubAgentMeta(output: string): { meta: SubAgentMeta | null; text: string } {
  if (!output.startsWith(META_PREFIX)) return { meta: null, text: output }
  const endIdx = output.indexOf(META_SUFFIX)
  if (endIdx < 0) return { meta: null, text: output }
  try {
    const json = output.slice(META_PREFIX.length, endIdx)
    const meta = JSON.parse(json) as SubAgentMeta
    const text = output.slice(endIdx + META_SUFFIX.length)
    return { meta, text }
  } catch {
    return { meta: null, text: output }
  }
}

export const TASK_TOOL_NAME = 'Task'

interface TeamContext {
  limiter: ConcurrencyLimiter
  workingFolder?: string
  defaultBackend?: 'in-process' | 'isolated-renderer'
}

const teamContexts = new Map<string, TeamContext>()

function getTeamContext(teamName: string): TeamContext {
  let ctx = teamContexts.get(teamName)
  if (!ctx) {
    ctx = { limiter: new ConcurrencyLimiter(2) }
    teamContexts.set(teamName, ctx)
  }
  return ctx
}

export function removeTeamLimiter(teamName: string): void {
  teamContexts.delete(teamName)
}

async function syncRuntimeTaskPatch(
  teamName: string,
  taskId: string,
  patch: Partial<{ status: TeamRuntimeTaskStatus; owner: string | null; report: string }>
): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team || team.name !== teamName) return

  await updateTeamRuntimeManifest({
    teamName,
    patch: {
      tasks: team.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    }
  })
}

function scheduleNextTask(teamName: string): void {
  const team = useTeamStore.getState().activeTeam
  if (!team || team.name !== teamName) return

  const ctx = teamContexts.get(teamName)
  if (!ctx) return
  const limiter = ctx.limiter
  if (limiter.activeCount >= 2) return

  const nextTask = findNextClaimableTask()
  if (!nextTask) return

  const memberName = `worker-${nanoid(4)}`
  const member: TeamMember = {
    id: nanoid(),
    name: memberName,
    model: 'default',
    backendType: ctx.defaultBackend ?? 'in-process',
    role: 'worker',
    status: 'idle',
    currentTaskId: nextTask.id,
    iteration: 0,
    toolCalls: [],
    streamingText: '',
    startedAt: Date.now(),
    completedAt: null
  }

  teamEvents.emit({ type: 'team_member_add', sessionId: team.sessionId, member })
  teamEvents.emit({
    type: 'team_task_update',
    sessionId: team.sessionId,
    taskId: nextTask.id,
    patch: { status: 'in_progress', owner: memberName }
  })

  limiter
    .acquire()
    .then(() => {
      return runTeammate({
        memberId: member.id,
        memberName,
        prompt: `Work on the following task:\n**Subject:** ${nextTask.subject}\n**Description:** ${nextTask.description}`,
        taskId: nextTask.id,
        model: null,
        agentName: null,
        workingFolder: ctx.workingFolder
      }).finally(() => {
        limiter.release()
        scheduleNextTask(teamName)
      })
    })
    .catch((err) => {
      console.error(`[Scheduler] Failed to start auto-teammate "${memberName}":`, err)
    })
}

function buildTaskDescription(agents: SubAgentDefinition[]): string {
  const agentLines = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types (use the corresponding name as "subagent_type"):
${agentLines}

When to use the Task tool:
- Use the Task tool with specialized sub-agents when the task at hand matches the sub-agent's description. Select the most appropriate subagent_type based on the descriptions above.
- For broader codebase exploration and deep research, prefer the Task tool over doing many sequential Glob/Grep/Read calls yourself.
- When working with a Team, use Task with run_in_background=true to spawn teammate agents.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead.
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead.
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead.

Usage notes:
1. Launch multiple tasks concurrently whenever possible.
2. When the sub-agent is done, it will return a single message back to you. The result is not visible to the user — send a text summary.
3. Each sub-agent invocation is stateless.
4. The sub-agent's outputs should generally be trusted.
5. Clearly tell the sub-agent whether you expect it to write code or just do research.
6. Set run_in_background=true to spawn a teammate agent that runs independently. When done, the teammate sends its results to you via SendMessage. Your turn ends after spawning — you will be notified when teammates finish.
7. Optional: set backend_type to choose between in-process and isolated-renderer teammate backends.`
}

async function executeBackgroundTeammate(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  if (ctx.callerAgent === 'teammate') {
    return encodeToolError(
      'Background teammate spawning is not allowed from a teammate. Send a message to the lead instead.'
    )
  }

  const team = useTeamStore.getState().activeTeam
  if (!team) {
    return encodeToolError('No active team. Call TeamCreate first.')
  }

  const requestedTeamName = input.team_name ? String(input.team_name) : null
  if (requestedTeamName && requestedTeamName !== team.name) {
    return encodeToolError(
      `Active team is "${team.name}", but received team_name="${requestedTeamName}".`
    )
  }

  const memberName = String(input.name ?? '')
  if (!memberName) {
    return encodeToolError('"name" is required when run_in_background=true')
  }

  const existing = team.members.find((m) => m.name === memberName)
  if (existing) {
    return encodeToolError(`Teammate "${memberName}" already exists in the team.`)
  }

  const subType = input.subagent_type ? String(input.subagent_type) : null
  const agentDefinition = subType ? subAgentRegistry.get(subType) : null
  if (subType && !agentDefinition) {
    return encodeToolError(`Unknown subagent_type "${subType}".`)
  }

  const teamName = team.name
  const teamCtx = getTeamContext(teamName)
  teamCtx.workingFolder = ctx.workingFolder
  teamCtx.defaultBackend = team.defaultBackend
  const limiter = teamCtx.limiter
  const backendType =
    input.backend_type === 'isolated-renderer' || input.backend_type === 'in-process'
      ? (input.backend_type as 'in-process' | 'isolated-renderer')
      : (team.defaultBackend ?? 'in-process')
  const willQueue = limiter.activeCount >= 2

  const assignedTaskId = input.task_id ? String(input.task_id) : null
  if (assignedTaskId) {
    const task = team.tasks.find((t) => t.id === assignedTaskId)
    if (task?.status === 'completed') {
      return encodeToolError(
        `Task "${assignedTaskId}" is already completed and cannot be re-assigned.`
      )
    }
  }

  const member: TeamMember = {
    id: nanoid(),
    name: memberName,
    model: String(input.model ?? 'default'),
    backendType,
    role: 'worker',
    ...(agentDefinition ? { agentName: agentDefinition.name } : {}),
    status: willQueue ? 'waiting' : 'idle',
    currentTaskId: assignedTaskId,
    iteration: 0,
    toolCalls: [],
    streamingText: '',
    startedAt: Date.now(),
    completedAt: null
  }

  teamEvents.emit({ type: 'team_member_add', sessionId: team.sessionId, member })
  void updateTeamRuntimeMember({
    teamName,
    memberId: member.id,
    patch: {
      agentId: member.id,
      name: member.name,
      role: 'worker',
      backendType,
      model: member.model,
      agentType: agentDefinition?.name,
      status: willQueue ? 'waiting' : 'idle',
      currentTaskId: assignedTaskId
    }
  }).catch((error) => {
    console.error('[TeamRuntime] Failed to sync teammate member record:', error)
  })

  if (assignedTaskId) {
    teamEvents.emit({
      type: 'team_task_update',
      sessionId: team.sessionId,
      taskId: assignedTaskId,
      patch: { status: 'in_progress', owner: memberName }
    })
    void syncRuntimeTaskPatch(teamName, assignedTaskId, {
      status: 'in_progress',
      owner: memberName
    }).catch((error) => {
      console.error('[TeamRuntime] Failed to sync assigned task state:', error)
    })
  }

  limiter
    .acquire()
    .then(() => {
      const markWorking = async (): Promise<void> => {
        teamEvents.emit({
          type: 'team_member_update',
          sessionId: team.sessionId,
          memberId: member.id,
          patch: { status: 'working' }
        })
        await updateTeamRuntimeMember({
          teamName,
          memberId: member.id,
          patch: { status: 'working' }
        })
      }

      const runPromise =
        backendType === 'isolated-renderer'
          ? spawnIsolatedTeamWorker({
              teamName,
              memberId: member.id,
              memberName,
              prompt: String(input.prompt ?? ''),
              taskId: assignedTaskId,
              model: input.model ? String(input.model) : null,
              agentName: agentDefinition?.name ?? null,
              workingFolder: ctx.workingFolder
            }).then(markWorking)
          : markWorking().then(() =>
              runTeammate({
                memberId: member.id,
                memberName,
                prompt: String(input.prompt ?? ''),
                taskId: assignedTaskId,
                model: input.model ? String(input.model) : null,
                agentName: agentDefinition?.name ?? null,
                workingFolder: ctx.workingFolder
              })
            )

      return runPromise.finally(() => {
        limiter.release()
        scheduleNextTask(teamName)
      })
    })
    .catch((err) => {
      console.error(`[Task/background] Failed to start teammate "${memberName}":`, err)
    })

  return encodeStructuredToolResult({
    success: true,
    member_id: member.id,
    name: memberName,
    team_name: teamName,
    backend_type: backendType,
    message: `Teammate "${memberName}" spawned and running in background via ${backendType}.`,
    instruction:
      'IMPORTANT: End your turn NOW. Do not call any more tools. Output a brief status summary and stop. You will be notified automatically when this teammate finishes.'
  })
}

export function createTaskTool(providerGetter: () => ProviderConfig): ToolHandler {
  const agents = subAgentRegistry.getAll()
  const subTypeEnum = agents.map((a) => a.name)

  return {
    definition: {
      name: TASK_TOOL_NAME,
      description: buildTaskDescription(agents),
      inputSchema: {
        type: 'object',
        oneOf: [
          {
            type: 'object',
            properties: {
              subagent_type: {
                type: 'string',
                enum: subTypeEnum,
                description: 'The type of specialized agent to use for this task'
              },
              description: {
                type: 'string',
                description: 'A short (3-5 word) description of the task'
              },
              prompt: {
                type: 'string',
                description: 'The task for the agent to perform'
              },
              model: {
                type: 'string',
                description: 'Optional model override for this agent.'
              }
            },
            required: ['subagent_type', 'description', 'prompt'],
            additionalProperties: false
          },
          {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'A short (3-5 word) description of the task'
              },
              prompt: {
                type: 'string',
                description: 'The task for the agent to perform'
              },
              run_in_background: {
                type: 'boolean',
                const: true,
                description:
                  'Set to true to run this agent in the background as a teammate. Requires an active team (TeamCreate).'
              },
              name: {
                type: 'string',
                description: 'Name for the spawned teammate agent (required in background mode)'
              },
              team_name: {
                type: 'string',
                description: 'Team name for spawning. Uses current team context if omitted.'
              },
              subagent_type: {
                type: 'string',
                enum: subTypeEnum,
                description: 'Optional specialized background agent type to use for this teammate.'
              },
              model: {
                type: 'string',
                description: 'Optional model override for this agent.'
              },
              task_id: {
                type: 'string',
                description: 'Optional task ID to assign to the teammate immediately'
              },
              backend_type: {
                type: 'string',
                enum: ['in-process', 'isolated-renderer'],
                description: 'Optional backend override for the teammate runtime.'
              }
            },
            required: ['description', 'prompt', 'run_in_background', 'name'],
            additionalProperties: false
          }
        ]
      }
    },
    execute: async (input, ctx) => {
      if (input.run_in_background) {
        return executeBackgroundTeammate(input, ctx)
      }

      const subType = String(input.subagent_type ?? '')
      if (!subType) {
        return encodeToolError(
          `"subagent_type" is required for synchronous Task. Available: ${subTypeEnum.join(', ')}`
        )
      }
      const def = subAgentRegistry.get(subType)
      if (!def) {
        return encodeToolError(
          `Unknown subagent_type "${subType}". Available: ${subTypeEnum.join(', ')}`
        )
      }

      // Guard against back-to-back identical Task calls: if the parent just
      // invoked this exact sub-agent with the same prompt, short-circuit and
      // replay the previous report with an instruction to move on. This
      // prevents runaway loops where a parent model keeps re-dispatching the
      // same sub-agent after each successful return.
      const dedupKey = buildTaskDedupKey(input)
      const sessionId = ctx.sessionId ?? ''
      const lastInvocation = sessionId ? lastTaskInvocationBySession.get(sessionId) : undefined
      if (
        sessionId &&
        lastInvocation &&
        lastInvocation.key === dedupKey &&
        lastInvocation.toolUseId !== (ctx.currentToolUseId ?? '')
      ) {
        return encodeStructuredToolResult({
          error:
            `Duplicate Task call blocked: the previous Task invocation to "${subType}" used an identical prompt ` +
            'and already returned a report. Do NOT re-launch the same sub-agent with the same prompt. ' +
            'Use the previous report below to continue your work, or call Task with a different sub-agent ' +
            'or a materially different prompt if you need new information.',
          previous_report: lastInvocation.output
        })
      }

      await subAgentLimiter.acquire(ctx.signal)

      try {
        const onEvent = (event: SubAgentEvent): void => {
          subAgentEvents.emit(event)
        }

        const result = await runSubAgent({
          definition: def,
          parentProvider: providerGetter(),
          toolContext: ctx,
          input,
          toolUseId: ctx.currentToolUseId ?? '',
          onEvent,
          onApprovalNeeded: async (tc: ToolCallState) => {
            const autoApprove = useSettingsStore.getState().autoApprove
            if (autoApprove) return true
            const approved = useAgentStore.getState().approvedToolNames
            if (approved.includes(tc.name)) return true
            useAgentStore.getState().addToolCall(tc)
            const result = await useAgentStore.getState().requestApproval(tc.id)
            if (result) useAgentStore.getState().addApprovedTool(tc.name)
            return result
          }
        })

        if (!result.success) {
          return encodeStructuredToolResult({
            error: result.error ?? 'SubAgent failed',
            result: result.output || undefined
          })
        }

        // Remember this invocation so a literal back-to-back repeat gets
        // blocked by the guard at the top of execute(). We only track
        // successful runs — failed runs are legitimate retry candidates.
        if (sessionId) {
          lastTaskInvocationBySession.set(sessionId, {
            key: dedupKey,
            output: result.output,
            toolUseId: ctx.currentToolUseId ?? ''
          })
        }

        return result.output
      } finally {
        subAgentLimiter.release()
      }
    },
    requiresApproval: (input) => !!input.run_in_background
  }
}
