import { nanoid } from 'nanoid'
import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import type { TeamTask } from '../types'

export const taskCreateTool: ToolHandler = {
  definition: {
    name: 'TaskCreate',
    description:
      'Create a task for the active team. Tasks can be assigned to teammates and tracked on the task board.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Short title for the task'
        },
        description: {
          type: 'string',
          description: 'Detailed description of what needs to be done'
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of task IDs this task depends on'
        }
      },
      required: ['subject', 'description']
    }
  },
  execute: async (input) => {
    const team = useTeamStore.getState().activeTeam
    const subject = String(input.subject)

    // Guard: skip if a task with the same subject already exists
    if (team) {
      const existing = team.tasks.find((t) => t.subject === subject)
      if (existing) {
        return encodeStructuredToolResult({
          success: true,
          task_id: existing.id,
          subject: existing.subject,
          note: 'Task with this subject already exists, returning existing task.'
        })
      }
    }

    const task: TeamTask = {
      id: nanoid(8),
      subject,
      description: String(input.description),
      status: 'pending',
      owner: null,
      dependsOn: Array.isArray(input.depends_on) ? input.depends_on.map(String) : []
    }

    teamEvents.emit({ type: 'team_task_add', task })

    return encodeStructuredToolResult({
      success: true,
      task_id: task.id,
      subject: task.subject
    })
  },
  requiresApproval: () => false
}
