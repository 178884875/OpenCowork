import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'

function StatusDot({ status }: { status: TaskItem['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full bg-green-500" />
        </span>
      )
    case 'in_progress':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2.5 rounded-full bg-blue-500/30 animate-ping" />
          <span className="size-2.5 rounded-full bg-blue-500" />
        </span>
      )
    case 'pending':
    default:
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full border border-muted-foreground/30" />
        </span>
      )
  }
}

interface TaskCardProps {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
}

function outputAsString(output: ToolResultContent | undefined): string | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') return output
  const texts = output
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
  return texts.join('\n') || undefined
}

function parseTaskSnapshot(output: ToolResultContent | undefined): {
  taskId?: string
  tasks: TaskItem[]
} | null {
  const text = outputAsString(output)
  if (!text) return null

  const parsed = decodeStructuredToolResult(text) as
    | {
        task_id?: unknown
        tasks?: Array<Partial<TaskItem>>
      }
    | null
  if (!parsed || Array.isArray(parsed) || !Array.isArray(parsed.tasks)) return null

  const tasks = parsed.tasks
      .filter(
        (task): task is Partial<TaskItem> & Pick<TaskItem, 'id' | 'subject' | 'status'> =>
          typeof task?.id === 'string' &&
          typeof task?.subject === 'string' &&
          typeof task?.status === 'string'
      )
      .map((task) => ({
        id: task.id,
        subject: task.subject,
        description: typeof task.description === 'string' ? task.description : '',
        activeForm: typeof task.activeForm === 'string' ? task.activeForm : undefined,
        status: task.status as TaskItem['status'],
        owner: typeof task.owner === 'string' || task.owner === null ? task.owner : undefined,
        blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : [],
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
        metadata: task.metadata,
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0
      }))

  return {
    taskId: typeof parsed.task_id === 'string' ? parsed.task_id : undefined,
    tasks
  }
}

export function TaskCard({ name, input, output }: TaskCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const liveTasks = useTaskStore((s) => s.tasks)
  const snapshot = React.useMemo(() => parseTaskSnapshot(output), [output])
  const tasks: TaskItem[] = snapshot?.tasks ?? liveTasks
  const focusedTaskId =
    snapshot?.taskId ?? (typeof input.taskId === 'string' ? input.taskId : undefined)

  const total = tasks.length || (name === 'TaskCreate' && input.subject ? 1 : 0)
  const completed = tasks.filter((t) => t.status === 'completed').length

  const pendingSubject = name === 'TaskCreate' && input.subject ? String(input.subject) : null

  if (total === 0 && !pendingSubject) {
    return <></>
  }

  return (
    <div className="my-5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t('todo.tasksDone', { completed, total })}</span>
      </div>

      <div className="mt-1.5 space-y-0.5 pl-1">
        {tasks.map((task) => (
          <div
            key={task.id}
            className={cn(
              'flex items-start gap-2 rounded-md px-1.5 py-1',
              task.id === focusedTaskId && 'bg-muted/40'
            )}
          >
            <span className="mt-0.5">
              <StatusDot status={task.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'text-xs leading-relaxed',
                  task.status === 'completed' && 'text-muted-foreground line-through',
                  task.status === 'pending' && 'text-muted-foreground/70'
                )}
              >
                {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
              </div>
              {task.owner && (
                <div className="text-[10px] text-muted-foreground/50">{task.owner}</div>
              )}
            </div>
          </div>
        ))}
        {total === 0 && pendingSubject && (
          <div className="flex items-start gap-2 rounded-md px-1.5 py-1">
            <span className="mt-0.5">
              <StatusDot status="pending" />
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground/70">
              {pendingSubject}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
