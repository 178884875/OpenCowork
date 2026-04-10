import type { ContentBlock, UnifiedMessage } from '@renderer/lib/api/types'
import type { TeamTask } from '@renderer/lib/agent/teams/types'
import type { SubAgentState } from '@renderer/stores/agent-store'
import { buildHistorySnapshot } from './build-history-snapshot'
import { buildStages, computeMemberProgress, deriveRunStatus, getUsageTokens } from './stage-resolver'
import type {
  BuildRunsInput,
  MemberTaskLookup,
  OrchestrationDerivedState,
  OrchestrationMember,
  OrchestrationRun,
  TeamCandidate
} from './types'

const TEAM_TOOL_NAMES = new Set(['TeamCreate', 'TaskCreate', 'TaskUpdate', 'TeamDelete', 'SendMessage'])
const SUBAGENT_TOOL_NAME = 'Task'

function getToolUseBlocks(message: UnifiedMessage): Array<Extract<ContentBlock, { type: 'tool_use' }>> {
  if (!Array.isArray(message.content)) return []
  return message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
  )
}

function getAllSubAgents(input: BuildRunsInput): SubAgentState[] {
  const merged = new Map<string, SubAgentState>()

  for (const item of input.subAgentHistory) {
    if (!input.sessionId || item.sessionId === input.sessionId) merged.set(item.toolUseId, item)
  }
  for (const item of Object.values(input.completedSubAgents)) {
    if (!input.sessionId || item.sessionId === input.sessionId) merged.set(item.toolUseId, item)
  }
  for (const item of Object.values(input.activeSubAgents)) {
    if (!input.sessionId || item.sessionId === input.sessionId) merged.set(item.toolUseId, item)
  }

  return [...merged.values()]
}

function getTeamCandidates(input: BuildRunsInput): TeamCandidate[] {
  const teams = [input.activeTeam, ...input.teamHistory].filter(
    (team): team is NonNullable<typeof team> => !!team && (!input.sessionId || team.sessionId === input.sessionId)
  )

  return teams
    .map((team) => {
      const sourceMessage = input.messages.find((message) => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return false
        return message.content.some(
          (block) =>
            block.type === 'tool_use' &&
            block.name === 'TeamCreate' &&
            String(block.input.team_name ?? '') === team.name
        )
      })

      return {
        team,
        runId: `team:${team.name}:${team.createdAt}`,
        sourceMessageId: sourceMessage?.id ?? `team-snapshot:${team.name}:${team.createdAt}`
      }
    })
    .sort((left, right) => right.team.createdAt - left.team.createdAt)
}

function createTaskLookup(tasks: TeamTask[]): MemberTaskLookup {
  const byId = new Map<string, TeamTask>()
  const byOwner = new Map<string, TeamTask>()

  for (const task of tasks) {
    byId.set(task.id, task)
    if (task.owner && !byOwner.has(task.owner)) byOwner.set(task.owner, task)
  }

  return { byId, byOwner }
}

function getMemberSummary(summary: string, fallback: string): string {
  return summary.trim() || fallback.trim()
}

function getLatestAction(summary: string, taskLabel?: string | null): string {
  if (taskLabel?.trim()) return taskLabel.trim()
  return summary.trim()
}

function mapSubAgentToMember(agent: SubAgentState): OrchestrationMember {
  const summary = getMemberSummary(agent.report, agent.streamingText || agent.errorMessage || '')
  const status: OrchestrationMember['status'] = agent.success === false
    ? 'failed'
    : agent.isRunning
      ? 'working'
      : 'completed'

  return {
    id: agent.toolUseId,
    toolUseId: agent.toolUseId,
    name: agent.displayName ?? agent.name,
    role: 'worker',
    agentName: agent.name,
    status,
    isRunning: agent.isRunning,
    iteration: agent.iteration,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    currentTaskId: null,
    currentTaskLabel: agent.description || null,
    description: agent.description || undefined,
    prompt: agent.prompt || undefined,
    summary,
    latestAction: getLatestAction(summary, agent.description),
    progress: computeMemberProgress({
      isRunning: agent.isRunning,
      toolCallCount: agent.toolCalls.length,
      iteration: agent.iteration,
      summary,
      report: agent.report
    }),
    usageTokens: getUsageTokens(agent.usage),
    toolCallCount: agent.toolCalls.length,
    transcript: agent.transcript,
    toolCalls: agent.toolCalls,
    report: agent.report,
    errorMessage: agent.errorMessage
  }
}

function mapTeamMember(teamMember: NonNullable<TeamCandidate['team']>['members'][number], taskLookup: MemberTaskLookup): OrchestrationMember {
  const currentTask =
    (teamMember.currentTaskId ? taskLookup.byId.get(teamMember.currentTaskId) : null) ??
    taskLookup.byOwner.get(teamMember.name) ??
    null
  const summary = getMemberSummary(teamMember.streamingText, currentTask?.report ?? '')

  return {
    id: teamMember.id,
    name: teamMember.name,
    role: teamMember.role,
    agentName: teamMember.agentName,
    model: teamMember.model,
    status: teamMember.status,
    isRunning: teamMember.status === 'working',
    iteration: teamMember.iteration,
    startedAt: teamMember.startedAt,
    completedAt: teamMember.completedAt,
    currentTaskId: currentTask?.id ?? teamMember.currentTaskId,
    currentTaskLabel: currentTask?.subject ?? null,
    description: currentTask?.description || undefined,
    summary,
    latestAction: getLatestAction(summary, currentTask?.subject),
    progress: computeMemberProgress({
      isRunning: teamMember.status === 'working',
      toolCallCount: teamMember.toolCalls.length,
      iteration: teamMember.iteration,
      summary,
      report: currentTask?.report
    }),
    usageTokens: getUsageTokens(teamMember.usage),
    toolCallCount: teamMember.toolCalls.length,
    transcript: [],
    toolCalls: teamMember.toolCalls,
    report: currentTask?.report,
    errorMessage: null
  }
}

function buildSingleAgentRun(agent: SubAgentState, sourceMessageId: string): OrchestrationRun {
  const member = mapSubAgentToMember(agent)
  const members = [member]
  const status = deriveRunStatus(members)
  const summary = member.summary || member.latestAction || agent.description || member.name
  const latestAction = member.latestAction || summary
  const { stageIndex, stageCount, stages } = buildStages({
    members,
    hasTasks: !!agent.description,
    hasMessages: agent.transcript.length > 0
  })

  const run: OrchestrationRun = {
    id: `single:${agent.toolUseId}`,
    sessionId: agent.sessionId,
    sourceMessageId,
    kind: 'single-agent',
    title: member.name,
    status,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    stageIndex,
    stageCount,
    stages,
    summary,
    latestAction,
    members,
    tasks: [],
    messages: [],
    selectedMemberId: member.id,
    sourceToolUseIds: [agent.toolUseId],
    historySnapshot: { summary: '', latestAction: '', members: [] }
  }

  run.historySnapshot = buildHistorySnapshot(run)
  return run
}

function buildTeamRun(candidate: TeamCandidate): OrchestrationRun {
  const taskLookup = createTaskLookup(candidate.team.tasks)
  const members = candidate.team.members.map((member) => mapTeamMember(member, taskLookup))
  const status = deriveRunStatus(members)
  const summary =
    candidate.team.tasks.find((task) => task.report?.trim())?.report?.trim() ||
    candidate.team.messages[candidate.team.messages.length - 1]?.summary ||
    candidate.team.description ||
    candidate.team.name
  const latestAction =
    candidate.team.messages[candidate.team.messages.length - 1]?.summary ||
    members.find((member) => member.isRunning)?.latestAction ||
    summary
  const { stageIndex, stageCount, stages } = buildStages({
    members,
    hasTasks: candidate.team.tasks.length > 0,
    hasMessages: candidate.team.messages.length > 0
  })

  const run: OrchestrationRun = {
    id: candidate.runId,
    sessionId: candidate.team.sessionId,
    sourceMessageId: candidate.sourceMessageId,
    kind: 'team',
    title: candidate.team.name,
    status,
    startedAt: candidate.team.createdAt,
    completedAt:
      status === 'running'
        ? null
        : Math.max(
            candidate.team.createdAt,
            ...candidate.team.members.map((member) => member.completedAt ?? member.startedAt)
          ),
    stageIndex,
    stageCount,
    stages,
    summary,
    latestAction,
    members,
    tasks: candidate.team.tasks,
    messages: candidate.team.messages,
    selectedMemberId: members[0]?.id ?? null,
    sourceToolUseIds: members.map((member) => member.toolUseId).filter(Boolean) as string[],
    historySnapshot: { summary: '', latestAction: '', members: [] },
    team: candidate.team
  }

  run.historySnapshot = buildHistorySnapshot(run)
  return run
}

function getSourceMessageIdForAgent(agent: SubAgentState, messages: UnifiedMessage[]): string {
  const sourceMessage = messages.find((message) => {
    if (message.role !== 'assistant') return false
    return getToolUseBlocks(message).some((block) => block.id === agent.toolUseId && block.name === SUBAGENT_TOOL_NAME)
  })
  return sourceMessage?.id ?? `single-snapshot:${agent.toolUseId}`
}

export function buildOrchestrationRuns(input: BuildRunsInput): OrchestrationDerivedState {
  const runs: OrchestrationRun[] = []
  const byId = new Map<string, OrchestrationRun>()
  const byMessageId = new Map<string, { primaryRun: OrchestrationRun | null; hiddenToolUseIds: Set<string> }>()

  const teamCandidates = getTeamCandidates(input)
  for (const candidate of teamCandidates) {
    const run = buildTeamRun(candidate)
    runs.push(run)
    byId.set(run.id, run)
    byMessageId.set(run.sourceMessageId, {
      primaryRun: run,
      hiddenToolUseIds: new Set(run.sourceToolUseIds)
    })
  }

  const usedToolUseIds = new Set<string>()
  for (const candidate of teamCandidates) {
    for (const member of candidate.team.members) {
      usedToolUseIds.add(member.id)
    }
  }

  for (const agent of getAllSubAgents(input)) {
    if (usedToolUseIds.has(agent.toolUseId)) continue
    const run = buildSingleAgentRun(agent, getSourceMessageIdForAgent(agent, input.messages))
    runs.push(run)
    byId.set(run.id, run)
    byMessageId.set(run.sourceMessageId, {
      primaryRun: run,
      hiddenToolUseIds: new Set(run.sourceToolUseIds)
    })
  }

  for (const message of input.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const binding = byMessageId.get(message.id)
    const hiddenToolUseIds = new Set(binding?.hiddenToolUseIds ?? [])
    for (const block of getToolUseBlocks(message)) {
      if (TEAM_TOOL_NAMES.has(block.name)) hiddenToolUseIds.add(block.id)
      if (block.name === SUBAGENT_TOOL_NAME) hiddenToolUseIds.add(block.id)
    }
    if (binding || hiddenToolUseIds.size > 0) {
      byMessageId.set(message.id, {
        primaryRun: binding?.primaryRun ?? null,
        hiddenToolUseIds
      })
    }
  }

  runs.sort((left, right) => right.startedAt - left.startedAt)
  return { runs, byId, byMessageId }
}
