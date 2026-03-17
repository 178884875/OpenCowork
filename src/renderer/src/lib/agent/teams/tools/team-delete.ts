import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import { useAgentStore } from '../../../../stores/agent-store'
import { abortAllTeammates } from '../teammate-runner'
import { removeTeamLimiter } from '../../sub-agents/create-tool'

export const teamDeleteTool: ToolHandler = {
  definition: {
    name: 'TeamDelete',
    description:
      'Delete the active team and clean up all resources. Use this when all tasks are completed and the team is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => {
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeToolError('No active team to delete')
    }

    const teamName = team.name
    const memberCount = team.members.length
    const taskCount = team.tasks.length
    const completedCount = team.tasks.filter((t) => t.status === 'completed').length

    // Stop all running teammate agent loops
    abortAllTeammates()

    // Resolve any pending approval promises from aborted teammates
    // so they don't block the PermissionDialog or leak memory
    useAgentStore.getState().clearPendingApprovals()

    // Clean up per-team concurrency limiter
    removeTeamLimiter(teamName)

    teamEvents.emit({ type: 'team_end' })

    return encodeStructuredToolResult({
      success: true,
      team_name: teamName,
      members_removed: memberCount,
      tasks_total: taskCount,
      tasks_completed: completedCount
    })
  },
  requiresApproval: () => true
}
