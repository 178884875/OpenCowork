import {
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  ClipboardList,
  Link2,
  Loader2,
  Users
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { usePlanStore } from '@renderer/stores/plan-store'
import { cn } from '@renderer/lib/utils'
import type { TeamTask } from '@renderer/lib/agent/teams/types'

const EMPTY_TEAM_TASKS: TeamTask[] = []
const EMPTY_TASKS: TaskItem[] = []
const EASE = [0.4, 0, 0.2, 1] as const

interface ProgressSummary {
  total: number
  completed: number
  percentage: number
}

interface StepsPanelData {
  todos: TaskItem[]
  plan?: {
    id: string
    title: string
  }
  planTasks: TaskItem[]
  standaloneTasks: TaskItem[]
  progress: ProgressSummary
  standaloneProgress: ProgressSummary
  teamName: string
  teamTasks: TeamTask[]
  isRunning: boolean
  hasContent: boolean
}

interface InlineTaskSummaryItem {
  id: string
  text: string
  label?: string
  tone: 'default' | 'plan' | 'team'
  status: TaskItem['status']
}

interface InlineChangeSummary {
  assistantMessageId: string
  fileCount: number
  added: number | null
  deleted: number | null
}

function buildProgress(
  items: Array<{ status: 'pending' | 'in_progress' | 'completed' }>
): ProgressSummary {
  const total = items.length
  const completed = items.filter((item) => item.status === 'completed').length
  return {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100)
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function countLines(text: string): number {
  const normalized = normalizeLineEndings(text)
  return normalized.length === 0 ? 0 : normalized.split('\n').length
}

function summarizeLineDiff(
  beforeText: string,
  afterText: string
): {
  added: number
  deleted: number
} {
  const beforeLines = normalizeLineEndings(beforeText).split('\n')
  const afterLines = normalizeLineEndings(afterText).split('\n')
  const beforeCount = beforeLines.length
  const afterCount = afterLines.length

  if (beforeCount * afterCount > 100000) {
    let prefix = 0
    while (
      prefix < beforeCount &&
      prefix < afterCount &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix += 1
    }

    let beforeSuffix = beforeCount - 1
    let afterSuffix = afterCount - 1
    while (
      beforeSuffix >= prefix &&
      afterSuffix >= prefix &&
      beforeLines[beforeSuffix] === afterLines[afterSuffix]
    ) {
      beforeSuffix -= 1
      afterSuffix -= 1
    }

    return {
      deleted: Math.max(0, beforeSuffix - prefix + 1),
      added: Math.max(0, afterSuffix - prefix + 1)
    }
  }

  const dp = Array.from({ length: beforeCount + 1 }, () => new Uint32Array(afterCount + 1))
  for (let i = 1; i <= beforeCount; i += 1) {
    for (let j = 1; j <= afterCount; j += 1) {
      dp[i][j] =
        beforeLines[i - 1] === afterLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const common = dp[beforeCount][afterCount]
  return {
    deleted: beforeCount - common,
    added: afterCount - common
  }
}

function summarizeInlineChangeSet(changeSet: {
  assistantMessageId: string
  changes: Array<{
    filePath: string
    op: 'create' | 'modify'
    before: { text?: string; previewText?: string; lineCount?: number }
    after: { text?: string; previewText?: string; lineCount?: number }
  }>
}): InlineChangeSummary | null {
  if (changeSet.changes.length === 0) return null

  const filePaths = new Set<string>()
  let added = 0
  let deleted = 0
  let hasLineStats = false

  for (const change of changeSet.changes) {
    filePaths.add(change.filePath)

    if (change.op === 'create') {
      const lineTotal =
        typeof change.after.lineCount === 'number'
          ? change.after.lineCount
          : typeof change.after.text === 'string'
            ? countLines(change.after.text)
            : typeof change.after.previewText === 'string'
              ? countLines(change.after.previewText)
              : 0
      if (lineTotal > 0) {
        added += lineTotal
        hasLineStats = true
      }
      continue
    }

    const beforeText = change.before.text ?? change.before.previewText
    const afterText = change.after.text ?? change.after.previewText
    if (typeof beforeText === 'string' && typeof afterText === 'string') {
      const diff = summarizeLineDiff(beforeText, afterText)
      added += diff.added
      deleted += diff.deleted
      hasLineStats = true
      continue
    }

    if (
      typeof change.before.lineCount === 'number' &&
      typeof change.after.lineCount === 'number' &&
      change.before.lineCount !== change.after.lineCount
    ) {
      if (change.after.lineCount > change.before.lineCount) {
        added += change.after.lineCount - change.before.lineCount
      } else {
        deleted += change.before.lineCount - change.after.lineCount
      }
      hasLineStats = true
    }
  }

  return {
    assistantMessageId: changeSet.assistantMessageId,
    fileCount: filePaths.size,
    added: hasLineStats ? added : null,
    deleted: hasLineStats ? deleted : null
  }
}

function useStepsPanelData(sessionId?: string | null): StepsPanelData {
  const resolvedSessionId = useChatStore((s) => sessionId ?? s.activeSessionId)
  const todos = useTaskStore((s) => {
    if (!resolvedSessionId) return s.tasks
    return s.currentSessionId === resolvedSessionId
      ? s.tasks
      : (s.tasksBySession[resolvedSessionId] ?? EMPTY_TASKS)
  })
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const hasStreamingMessage = useChatStore((s) =>
    resolvedSessionId ? Boolean(s.streamingMessages[resolvedSessionId]) : false
  )
  const isRunning =
    useAgentStore((s) => s.isSessionActive(resolvedSessionId)) || hasStreamingMessage
  const plan = usePlanStore(
    useShallow((s) => {
      if (!resolvedSessionId) return undefined
      const item = Object.values(s.plans).find((p) => p.sessionId === resolvedSessionId)
      return item ? { id: item.id, title: item.title } : undefined
    })
  )

  const showTeamTasks = Boolean(
    activeTeam && (!activeTeam.sessionId || activeTeam.sessionId === resolvedSessionId)
  )
  const teamName = showTeamTasks ? (activeTeam?.name ?? 'Team') : 'Team'
  const teamTasks = showTeamTasks ? (activeTeam?.tasks ?? EMPTY_TEAM_TASKS) : EMPTY_TEAM_TASKS

  const planTasks = useMemo(
    () => (plan ? todos.filter((t) => t.planId === plan.id) : []),
    [plan, todos]
  )
  const standaloneTasks = useMemo(
    () => (plan ? todos.filter((t) => !t.planId) : todos),
    [plan, todos]
  )
  const progress = useMemo(() => buildProgress(plan ? planTasks : todos), [plan, planTasks, todos])
  const standaloneProgress = useMemo(() => buildProgress(standaloneTasks), [standaloneTasks])
  const hasContent = todos.length > 0 || teamTasks.length > 0

  return {
    todos,
    plan,
    planTasks,
    standaloneTasks,
    progress,
    standaloneProgress,
    teamName,
    teamTasks,
    isRunning,
    hasContent
  }
}

function TaskStatusIcon({ status }: { status: TaskItem['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-4 text-green-500" />
    case 'in_progress':
      return <Loader2 className="size-4 animate-spin text-blue-500" />
    case 'pending':
    default:
      return <Circle className="size-4 text-muted-foreground" />
  }
}

function getTaskPrimaryText(task: Pick<TaskItem, 'status' | 'activeForm' | 'subject'>): string {
  return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
}

function getSecondaryDescription(
  description: string | null | undefined,
  primaryText: string
): string | null {
  if (typeof description !== 'string') return null
  const trimmed = description.trim()
  if (!trimmed || trimmed === primaryText.trim()) return null
  return trimmed
}

function TaskDescriptionPreview({
  description,
  className,
  completed = false
}: {
  description: string | null | undefined
  className?: string
  completed?: boolean
}): React.JSX.Element | null {
  if (!description) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'block min-w-0 shrink basis-[42%] cursor-default truncate text-right text-[11px] leading-5 text-muted-foreground/65',
            completed && 'text-muted-foreground/45 line-through',
            className
          )}
        >
          {description}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        sideOffset={6}
        className="max-w-[320px] whitespace-pre-wrap break-words text-left leading-relaxed"
      >
        {description}
      </TooltipContent>
    </Tooltip>
  )
}

function StepsPanelContent({
  data,
  className
}: {
  data: StepsPanelData
  className?: string
}): React.JSX.Element {
  const {
    plan,
    todos,
    planTasks,
    standaloneTasks,
    progress,
    standaloneProgress,
    teamTasks,
    teamName
  } = data

  return (
    <div className={cn('space-y-2', className)}>
      {/* Plan-linked tasks */}
      {plan && planTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center rounded-md bg-violet-500/10 p-1">
              <ClipboardList className="size-3.5 text-violet-500" />
            </div>
            <span className="truncate text-xs font-medium text-violet-600 dark:text-violet-400">
              {plan.title}
            </span>
            <Badge variant="secondary" className="h-4 px-1 text-[9px]">
              {progress.completed}/{progress.total}
            </Badge>
          </div>
          <TodoList todos={planTasks} progress={progress} />
        </div>
      )}

      {/* Standalone tasks (not linked to plan) */}
      {standaloneTasks.length > 0 && (
        <>
          {plan && planTasks.length > 0 && <Separator />}
          <TodoList todos={standaloneTasks} progress={standaloneProgress} />
        </>
      )}

      {(planTasks.length > 0 || standaloneTasks.length > 0 || todos.length > 0) &&
        teamTasks.length > 0 && <Separator />}
      {teamTasks.length > 0 && <TeamTaskList tasks={teamTasks} teamName={teamName} />}
    </div>
  )
}

export function StepsPanel({ sessionId }: { sessionId?: string | null } = {}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const data = useStepsPanelData(sessionId)

  if (!data.hasContent && !data.isRunning) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Circle className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('steps.noTasks')}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">{t('steps.noTasksDesc')}</p>
      </div>
    )
  }

  return <StepsPanelContent data={data} className="max-h-[calc(100vh-200px)] overflow-y-auto" />
}

function InlinePreviewTag({
  label,
  tone
}: {
  label: string
  tone: InlineTaskSummaryItem['tone']
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'max-w-[180px] truncate rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
        tone === 'plan' &&
          'border-violet-500/20 bg-violet-500/8 text-violet-600 dark:text-violet-400',
        tone === 'team' && 'border-cyan-500/20 bg-cyan-500/8 text-cyan-600 dark:text-cyan-400',
        tone === 'default' && 'border-border/60 bg-background/70 text-muted-foreground'
      )}
    >
      {label}
    </span>
  )
}

function InlineStepsPanelCard({
  summaryLabel,
  canExpand,
  summaryItems,
  changeSummary,
  changedFilesLabel,
  reviewLabel
}: {
  summaryLabel: string
  canExpand: boolean
  summaryItems: InlineTaskSummaryItem[]
  changeSummary: InlineChangeSummary | null
  changedFilesLabel: string | null
  reviewLabel: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const handleOpenChangeReview = (): void => {
    if (!changeSummary?.assistantMessageId) return
    const target = document.querySelector<HTMLElement>(
      `[data-message-id="${changeSummary.assistantMessageId}"]`
    )
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border/60 bg-background/80 shadow-sm">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/20 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ClipboardList className="size-3.5 shrink-0 text-muted-foreground/80" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
          {summaryLabel}
        </span>
        {canExpand && (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
              expanded && 'rotate-180'
            )}
          />
        )}
      </button>

      {changeSummary && !expanded && (
        <div className="flex items-center justify-between gap-3 border-t border-border/50 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="truncate text-muted-foreground">{changedFilesLabel}</span>
            {(changeSummary.added !== null || changeSummary.deleted !== null) && (
              <span className="shrink-0 space-x-1 text-[11px] tabular-nums">
                {changeSummary.added !== null && (
                  <span className="text-emerald-500">+{changeSummary.added}</span>
                )}
                {changeSummary.deleted !== null && (
                  <span className="text-red-500">-{changeSummary.deleted}</span>
                )}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleOpenChangeReview}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-foreground/85 transition-colors hover:text-foreground"
          >
            <span>{reviewLabel}</span>
            <ArrowUpRight className="size-3" />
          </button>
        </div>
      )}

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            key="expanded"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            style={{ overflow: 'hidden' }}
            className="border-t border-border/50"
          >
            <div className="max-h-64 overflow-y-auto px-3 py-3">
              <ol className="space-y-1.5">
                {summaryItems.map((item, index) => (
                  <li
                    key={item.id}
                    className="grid grid-cols-[24px_minmax(0,1fr)] gap-2 text-[13px] leading-5"
                  >
                    <span
                      className={cn(
                        'select-none pt-0.5 text-right tabular-nums text-muted-foreground/70',
                        item.status === 'completed' && 'text-muted-foreground/45'
                      )}
                    >
                      {index + 1}.
                    </span>
                    <div className="min-w-0 flex items-start gap-2">
                      {item.label && <InlinePreviewTag label={item.label} tone={item.tone} />}
                      <span
                        className={cn(
                          'min-w-0 flex-1 break-words',
                          item.status === 'completed' && 'text-muted-foreground/60 line-through',
                          item.status === 'pending' && 'text-muted-foreground/80'
                        )}
                      >
                        {item.text}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            {changeSummary && (
              <div className="flex items-center justify-between gap-3 border-t border-border/50 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{changedFilesLabel}</span>
                  {(changeSummary.added !== null || changeSummary.deleted !== null) && (
                    <span className="shrink-0 space-x-1 text-[11px] tabular-nums">
                      {changeSummary.added !== null && (
                        <span className="text-emerald-500">+{changeSummary.added}</span>
                      )}
                      {changeSummary.deleted !== null && (
                        <span className="text-red-500">-{changeSummary.deleted}</span>
                      )}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleOpenChangeReview}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-foreground/85 transition-colors hover:text-foreground"
                >
                  <span>{reviewLabel}</span>
                  <ArrowUpRight className="size-3" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function InlineStepsPanel({
  sessionId
}: {
  sessionId?: string | null
}): React.JSX.Element | null {
  const { t } = useTranslation(['cowork', 'chat'])
  const data = useStepsPanelData(sessionId)
  const resolvedSessionId = useChatStore((s) => sessionId ?? s.activeSessionId)
  const latestChangeSet = useAgentStore((s) => {
    if (!resolvedSessionId) return null

    let nextMatch: {
      assistantMessageId: string
      updatedAt: number
      changes: Array<{
        filePath: string
        op: 'create' | 'modify'
        before: { text?: string; previewText?: string; lineCount?: number }
        after: { text?: string; previewText?: string; lineCount?: number }
      }>
    } | null = null

    for (const changeSet of Object.values(s.runChangesByRunId)) {
      if (
        changeSet.sessionId !== resolvedSessionId ||
        changeSet.changes.length === 0 ||
        (changeSet.status !== 'open' &&
          changeSet.status !== 'partial' &&
          changeSet.status !== 'conflicted')
      ) {
        continue
      }

      if (!nextMatch || changeSet.updatedAt > nextMatch.updatedAt) {
        nextMatch = {
          assistantMessageId: changeSet.assistantMessageId,
          updatedAt: changeSet.updatedAt,
          changes: changeSet.changes
        }
      }
    }

    return nextMatch
  })

  const summaryTotal = data.todos.length + data.teamTasks.length
  const summaryCompleted =
    data.todos.filter((task) => task.status === 'completed').length +
    data.teamTasks.filter((task) => task.status === 'completed').length

  const summaryItems = useMemo<InlineTaskSummaryItem[]>(() => {
    const items: InlineTaskSummaryItem[] = []

    if (data.plan) {
      for (const task of data.planTasks) {
        items.push({
          id: `plan-${task.id}`,
          text: getTaskPrimaryText(task),
          label: data.plan.title,
          tone: 'plan',
          status: task.status
        })
      }
    }

    for (const task of data.standaloneTasks) {
      items.push({
        id: `task-${task.id}`,
        text: getTaskPrimaryText(task),
        tone: 'default',
        status: task.status
      })
    }

    for (const task of data.teamTasks) {
      items.push({
        id: `team-${task.id}`,
        text: task.activeForm ?? task.subject,
        label: data.teamName,
        tone: 'team',
        status: task.status
      })
    }

    return items
  }, [data.plan, data.planTasks, data.standaloneTasks, data.teamName, data.teamTasks])

  const changeSummary = useMemo(
    () => (latestChangeSet ? summarizeInlineChangeSet(latestChangeSet) : null),
    [latestChangeSet]
  )

  if (!data.hasContent && !changeSummary) {
    return null
  }

  const canExpand = summaryItems.length > 0
  const summaryLabel = t('steps.inlineSummary', {
    ns: 'cowork',
    total: summaryTotal,
    completed: summaryCompleted,
    defaultValue: '{{total}} tasks, {{completed}} completed'
  })
  const changedFilesLabel = changeSummary
    ? t('steps.changedFiles', {
        ns: 'cowork',
        count: changeSummary.fileCount,
        defaultValue: '{{count}} files changed'
      })
    : null
  const reviewLabel = t('fileChange.runStatus.review', { ns: 'chat' })

  return (
    <InlineStepsPanelCard
      key={`${resolvedSessionId ?? 'global'}:${data.isRunning ? 'running' : 'idle'}`}
      summaryLabel={summaryLabel}
      canExpand={canExpand}
      summaryItems={summaryItems}
      changeSummary={changeSummary}
      changedFilesLabel={changedFilesLabel}
      reviewLabel={reviewLabel}
    />
  )
}

function TodoList({
  todos,
  progress
}: {
  todos: TaskItem[]
  progress: { total: number; completed: number; percentage: number }
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  return (
    <div className="space-y-2">
      {todos.length > 0 && (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('steps.progress')}</span>
              <span>
                {progress.completed}/{progress.total} ({progress.percentage}%)
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
          </div>

          <ul className="space-y-1">
            {todos.map((todo) => {
              const primaryText = getTaskPrimaryText(todo)
              const secondaryText = getSecondaryDescription(todo.description, primaryText)
              return (
                <li
                  key={todo.id}
                  className={cn(
                    'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
                    todo.status === 'in_progress' && 'bg-blue-500/5'
                  )}
                >
                  <span className="mt-0.5 shrink-0">
                    <TaskStatusIcon status={todo.status} />
                  </span>
                  <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                    <div
                      className={cn(
                        'min-w-0 flex-1',
                        todo.status === 'completed' && 'text-muted-foreground line-through'
                      )}
                    >
                      {primaryText}
                    </div>
                    <TaskDescriptionPreview
                      description={secondaryText}
                      completed={todo.status === 'completed'}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

// ── Team Task List (Todo-like display for team tasks) ────────────

function TeamTaskStatusIcon({ status }: { status: TeamTask['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-4 text-green-500" />
    case 'in_progress':
      return <Loader2 className="size-4 animate-spin text-cyan-500" />
    case 'pending':
    default:
      return <Circle className="size-4 text-muted-foreground" />
  }
}

function TeamTaskList({
  tasks,
  teamName
}: {
  tasks: TeamTask[]
  teamName: string
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const percentage = tasks.length === 0 ? 0 : Math.round((completedCount / tasks.length) * 100)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center rounded-md bg-cyan-500/10 p-1">
          <Users className="size-3.5 text-cyan-500" />
        </div>
        <span className="truncate text-xs font-medium text-cyan-600 dark:text-cyan-400">
          {teamName}
        </span>
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
          {completedCount}/{tasks.length}
        </Badge>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('steps.teamProgress')}</span>
          <span>{percentage}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-cyan-500 transition-all duration-300"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <ul className="space-y-1">
        {tasks.map((task) => {
          const primaryText = task.activeForm ?? task.subject
          const secondaryText = getSecondaryDescription(task.description, primaryText)
          return (
            <li
              key={task.id}
              className={cn(
                'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
                task.status === 'in_progress' && 'bg-cyan-500/5'
              )}
            >
              <span className="mt-0.5 shrink-0">
                <TeamTaskStatusIcon status={task.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div
                    className={cn(
                      'min-w-0 flex-1',
                      task.status === 'completed' && 'text-muted-foreground line-through'
                    )}
                  >
                    {primaryText}
                  </div>
                  <TaskDescriptionPreview
                    description={secondaryText}
                    completed={task.status === 'completed'}
                  />
                </div>
                {(task.owner || task.dependsOn.length > 0) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    {task.owner && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-cyan-500/60">
                        <Bot className="size-2.5" />
                        {task.owner}
                      </span>
                    )}
                    {task.dependsOn.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/40">
                        <Link2 className="size-2.5" />
                        {task.dependsOn.length} deps
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
