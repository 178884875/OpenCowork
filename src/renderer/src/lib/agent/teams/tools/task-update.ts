import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import type { TeamTaskStatus } from '../types'

const VALID_STATUSES: TeamTaskStatus[] = ['pending', 'in_progress', 'completed']

export const taskUpdateTool: ToolHandler = {
  definition: {
    name: 'TaskUpdate',
    description:
      'Update a task status or owner in the active team. Use this to claim a task, mark it in progress, or mark it completed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to update'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New status for the task'
        },
        owner: {
          type: 'string',
          description: 'Name of the teammate claiming this task'
        },
        report: {
          type: 'string',
          description:
            'Final report to attach when completing a task. Include all findings, data collected, and results. This report is sent to the lead agent automatically.'
        }
      },
      required: ['task_id']
    }
  },
  execute: async (input) => {
    const taskId = String(input.task_id)
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeToolError('No active team')
    }

    const task = team.tasks.find((t) => t.id === taskId)
    if (!task) {
      return encodeToolError(`Task "${taskId}" not found`)
    }

    const patch: Record<string, unknown> = {}
    if (input.status && VALID_STATUSES.includes(input.status as TeamTaskStatus)) {
      // Guard: never roll back a completed task
      if (task.status === 'completed' && input.status !== 'completed') {
        return encodeStructuredToolResult({
          error: `Task "${taskId}" is already completed and cannot be reverted to "${input.status}".`
        })
      }
      patch.status = input.status
    }
    if (input.owner !== undefined) {
      patch.owner = String(input.owner)
    }
    if (input.report !== undefined && patch.status === 'completed') {
      patch.report = String(input.report)
    }

    teamEvents.emit({ type: 'team_task_update', taskId, patch })

    return encodeStructuredToolResult({
      success: true,
      task_id: taskId,
      updated: patch
    })
  },
  requiresApproval: () => false
}
