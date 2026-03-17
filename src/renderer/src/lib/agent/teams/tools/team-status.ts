import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { useTeamStore } from '../../../../stores/team-store'

/**
 * TeamStatus — non-blocking snapshot of the current team state.
 * Returns members, tasks, and recent messages without waiting.
 * Use this to check progress without waiting.
 */
export const teamStatusTool: ToolHandler = {
  definition: {
    name: 'TeamStatus',
    description:
      'Get a snapshot of the current team state: all members with their status, all tasks, and recent messages. Non-blocking — returns immediately. Use this to check progress without waiting.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => {
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeToolError('No active team')
    }

    const completedTasks = team.tasks.filter((t) => t.status === 'completed').length
    const workingMembers = team.members.filter((m) => m.status === 'working').length

    return encodeStructuredToolResult({
      team_name: team.name,
      description: team.description,
      summary: `${team.members.length} members (${workingMembers} working), ${completedTasks}/${team.tasks.length} tasks completed`,
      members: team.members.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        model: m.model,
        current_task_id: m.currentTaskId,
        iteration: m.iteration,
        tool_calls_count: m.toolCalls.length,
        started_at: m.startedAt,
        completed_at: m.completedAt
      })),
      tasks: team.tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        depends_on: t.dependsOn
      })),
      recent_messages: team.messages.slice(-10).map((msg) => ({
        from: msg.from,
        to: msg.to,
        type: msg.type,
        content: msg.content,
        summary: msg.summary
      }))
    })
  },
  requiresApproval: () => false
}
