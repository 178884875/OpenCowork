import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  FileText,
  Users,
  Bot,
  Terminal,
  SendHorizontal,
  Clock,
  ChevronDown,
  ChevronRight,
  Wrench,
  History,
} from 'lucide-react'
import { useUIStore } from '@renderer/stores/ui-store'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { TeamPanel } from '@renderer/components/cowork/TeamPanel'
import { ToolCallCard } from '@renderer/components/chat/ToolCallCard'
import { Separator } from '@renderer/components/ui/separator'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AnimatePresence, motion } from 'motion/react'
import { FadeIn } from '@renderer/components/animate-ui'

// ── Helpers ──────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

// ── Team History View ────────────────────────────────────────────

function TeamHistoryItem({ team, isExpanded, onToggle }: {
  team: ActiveTeam
  isExpanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const completedTasks = team.tasks.filter((task) => task.status === 'completed').length
  return (
    <div className="rounded-lg border border-muted overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Users className="size-3.5 text-cyan-500 shrink-0" />
        <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 truncate flex-1">
          {team.name}
        </span>
        <span className="text-[9px] text-muted-foreground/50">{t('detailPanel.membersCount', { count: team.members.length })}</span>
        <span className="text-[9px] text-muted-foreground/50">{t('detailPanel.tasksCount', { completed: completedTasks, total: team.tasks.length })}</span>
        <span className="text-[9px] text-muted-foreground/40">{formatDate(team.createdAt)}</span>
        {isExpanded ? <ChevronDown className="size-3 text-muted-foreground/40" /> : <ChevronRight className="size-3 text-muted-foreground/40" />}
      </button>
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-muted px-3 py-2 space-y-2 overflow-hidden"
          >
            <p className="text-[10px] text-muted-foreground/60">{team.description}</p>

            {/* Members summary */}
            {team.members.length > 0 && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider">{t('detailPanel.membersLabel')}</span>
                <div className="mt-1 space-y-1">
                  {team.members.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 text-[10px]">
                      <span className={cn(
                        'size-1.5 rounded-full shrink-0',
                        m.status === 'working' ? 'bg-green-500 animate-pulse' : m.status === 'stopped' ? 'bg-muted-foreground/30' : 'bg-cyan-400',
                      )} />
                      <span className="font-medium text-cyan-600 dark:text-cyan-400">{m.name}</span>
                      <span className="text-muted-foreground/40">{m.toolCalls.length} calls</span>
                      <span className="text-muted-foreground/40">{m.iteration} iters</span>
                      {m.completedAt && m.startedAt && (
                        <span className="text-muted-foreground/30">{formatElapsed(m.completedAt - m.startedAt)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tasks summary */}
            {team.tasks.length > 0 && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider">{t('detailPanel.tasksLabel')}</span>
                <div className="mt-1 space-y-0.5">
                  {team.tasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-1.5 text-[10px]">
                      <Badge variant="secondary" className={cn(
                        'text-[7px] h-3 px-1',
                        task.status === 'completed' ? 'bg-green-500/15 text-green-500' :
                        task.status === 'in_progress' ? 'bg-blue-500/15 text-blue-500' :
                        'bg-muted text-muted-foreground/60',
                      )}>
                        {task.status === 'completed' ? t('status.done', { ns: 'common' }) : task.status === 'in_progress' ? t('status.active', { ns: 'common' }) : t('status.pending', { ns: 'common' })}
                      </Badge>
                      <span className="truncate text-muted-foreground/70">{task.subject}</span>
                      {task.owner && <span className="text-cyan-500/50 shrink-0">{task.owner}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Messages count */}
            {team.messages.length > 0 && (
              <span className="text-[9px] text-muted-foreground/40">{t('detailPanel.messagesExchanged', { count: team.messages.length })}</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TeamDetailView(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const teamHistory = useTeamStore((s) => s.teamHistory)
  const [expandedIdx, setExpandedIdx] = React.useState<number | null>(null)

  return (
    <div className="space-y-3">
      {/* Active team */}
      <TeamPanel />

      {/* History */}
      {teamHistory.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <History className="size-3 text-muted-foreground/50" />
              <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">{t('detailPanel.history')}</span>
              <Badge variant="secondary" className="text-[8px] h-3.5 px-1">{teamHistory.length}</Badge>
            </div>
            <div className="space-y-1.5">
              {teamHistory.slice().reverse().map((team, i) => (
                <TeamHistoryItem
                  key={`${team.name}-${team.createdAt}`}
                  team={team}
                  isExpanded={expandedIdx === i}
                  onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── SubAgent Detail View ─────────────────────────────────────────

function SubAgentDetailItem({ sa, isOpen, onToggle, inlineText }: { sa: SubAgentState; isOpen: boolean; onToggle: () => void; inlineText?: string }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const elapsed = sa.completedAt && sa.startedAt ? sa.completedAt - sa.startedAt : null
  const textContent = sa.streamingText || inlineText || ''
  const hasText = textContent.trim().length > 0

  return (
    <div className="rounded-lg border border-muted overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Bot className="size-3.5 text-violet-500 shrink-0" />
        <span className="text-xs font-semibold text-violet-600 dark:text-violet-400 truncate flex-1">
          {sa.name}
        </span>
        <Badge variant={sa.isRunning ? 'default' : 'secondary'} className={cn('text-[8px] h-3.5 px-1', sa.isRunning && 'bg-violet-500 animate-pulse')}>
          {sa.isRunning ? 'running' : 'done'}
        </Badge>
        <span className="text-[9px] text-muted-foreground/40">{sa.toolCalls.length} calls</span>
        {elapsed != null && (
          <span className="text-[9px] text-muted-foreground/30 flex items-center gap-0.5">
            <Clock className="size-2.5" />
            {formatElapsed(elapsed)}
          </span>
        )}
        {isOpen ? <ChevronDown className="size-3 text-muted-foreground/40" /> : <ChevronRight className="size-3 text-muted-foreground/40" />}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-muted px-3 py-2 space-y-2 overflow-hidden"
          >
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
              <span>{t('detailPanel.iterations', { count: sa.iteration })}</span>
              <span>·</span>
              <span>{t('detailPanel.toolCalls', { count: sa.toolCalls.length })}</span>
              {elapsed != null && <><span>·</span><span>{formatElapsed(elapsed)}</span></>}
            </div>

            {/* Streaming text / final output */}
            {hasText && (
              <div className="rounded-md bg-violet-500/[0.03] border border-violet-500/10 px-2.5 py-2 max-h-[360px] overflow-y-auto">
                <div className="prose prose-xs dark:prose-invert max-w-none text-[11px] leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]}>{textContent}</Markdown>
                </div>
              </div>
            )}

            {/* Tool Calls */}
            {sa.toolCalls.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Wrench className="size-2.5 text-muted-foreground/50" />
                  <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider">{t('detailPanel.toolCallsLabel')}</span>
                </div>
                <div className="space-y-1 max-h-[400px] overflow-y-auto">
                  {sa.toolCalls.map((tc) => (
                    <ToolCallCard
                      key={tc.id}
                      toolUseId={tc.id}
                      name={tc.name}
                      input={tc.input}
                      output={tc.output}
                      status={tc.status}
                      error={tc.error}
                      startedAt={tc.startedAt}
                      completedAt={tc.completedAt}
                    />
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function SubAgentDetailView({ toolUseId, inlineText }: { toolUseId?: string; inlineText?: string }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const subAgentHistory = useAgentStore((s) => s.subAgentHistory)

  // Accordion: only one item open at a time across all lists
  const [expandedId, setExpandedId] = React.useState<string | null>(toolUseId ?? null)
  const toggle = (id: string): void => setExpandedId((prev) => (prev === id ? null : id))

  // Current active + completed
  const currentAgents: SubAgentState[] = [
    ...Object.values(activeSubAgents),
    ...Object.values(completedSubAgents),
  ]

  // If a specific toolUseId is requested, find and highlight it
  const targeted = toolUseId
    ? currentAgents.find((sa) => sa.toolUseId === toolUseId) ?? subAgentHistory.find((sa) => sa.toolUseId === toolUseId)
    : null

  return (
    <div className="space-y-3">
      {/* Targeted SubAgent */}
      {targeted && (
        <SubAgentDetailItem
          sa={targeted}
          isOpen={expandedId === targeted.toolUseId}
          onToggle={() => toggle(targeted.toolUseId)}
          inlineText={targeted.toolUseId === toolUseId ? inlineText : undefined}
        />
      )}

      {/* Standalone text fallback when state not found */}
      {!targeted && inlineText && (
        <div className="rounded-lg border border-muted/80 bg-muted/10 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Bot className="size-3.5 text-violet-500" />
            <span className="text-xs font-semibold text-violet-600 dark:text-violet-400">
              {t('detailPanel.subAgentOutput')}
            </span>
          </div>
          <div className="prose prose-xs dark:prose-invert max-w-none text-[11px] leading-relaxed">
            <Markdown remarkPlugins={[remarkGfm]}>{inlineText}</Markdown>
          </div>
        </div>
      )}

      {/* Current session SubAgents */}
      {currentAgents.length > 0 && !targeted && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Bot className="size-3 text-muted-foreground/50" />
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">{t('detailPanel.current')}</span>
            <Badge variant="secondary" className="text-[8px] h-3.5 px-1">{currentAgents.length}</Badge>
          </div>
          <div className="space-y-1.5">
            {currentAgents.map((sa) => (
              <SubAgentDetailItem
                key={sa.toolUseId}
                sa={sa}
                isOpen={expandedId === sa.toolUseId}
                onToggle={() => toggle(sa.toolUseId)}
                inlineText={sa.toolUseId === toolUseId ? inlineText : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* History */}
      {subAgentHistory.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <History className="size-3 text-muted-foreground/50" />
              <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">{t('detailPanel.history')}</span>
              <Badge variant="secondary" className="text-[8px] h-3.5 px-1">{subAgentHistory.length}</Badge>
            </div>
            <div className="space-y-1.5">
              {subAgentHistory.slice().reverse().map((sa) => (
                <SubAgentDetailItem
                  key={sa.toolUseId}
                  sa={sa}
                  isOpen={expandedId === sa.toolUseId}
                  onToggle={() => toggle(sa.toolUseId)}
                  inlineText={sa.toolUseId === toolUseId ? inlineText : undefined}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {currentAgents.length === 0 && subAgentHistory.length === 0 && !targeted && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Bot className="mb-3 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t('detailPanel.noSubAgentRecords')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            {t('detailPanel.subAgentActivity')}
          </p>
        </div>
      )}
    </div>
  )
}

function TerminalDetailView({ processId }: { processId: string }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const process = useAgentStore((s) => s.backgroundProcesses[processId])
  const sendBackgroundProcessInput = useAgentStore((s) => s.sendBackgroundProcessInput)
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const [input, setInput] = React.useState('')
  const outputRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!outputRef.current) return
    outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [process?.output, process?.status])

  if (!process) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Terminal className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('detailPanel.terminalNotFound')}</p>
      </div>
    )
  }

  const isRunning = process.status === 'running'
  const statusText =
    process.status === 'running'
      ? t('detailPanel.running')
      : process.status === 'stopped'
        ? t('detailPanel.stopped')
        : process.status === 'error'
          ? t('detailPanel.error')
          : t('detailPanel.exited')

  const handleSend = (): void => {
    if (input.length === 0 || !isRunning) return
    void sendBackgroundProcessInput(processId, input, true)
    setInput('')
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-lg border border-muted p-3">
        <div className="flex items-center gap-2">
          <Badge
            variant={isRunning ? 'default' : 'secondary'}
            className={cn('text-[10px]', isRunning && 'bg-emerald-500')}
          >
            {statusText}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {t('detailPanel.processId')}: {process.id}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('detailPanel.command')}: <span className="font-mono">{process.command}</span>
        </div>
        {process.cwd && (
          <div className="text-xs text-muted-foreground">
            {t('detailPanel.workingDirectory')}: <span className="font-mono">{process.cwd}</span>
          </div>
        )}
      </div>

      <div
        ref={outputRef}
        className="h-[360px] overflow-auto rounded-lg border bg-zinc-950 px-3 py-2 text-[11px] font-mono text-zinc-200 whitespace-pre-wrap break-words"
      >
        {process.output || '[no output yet]'}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={t('detailPanel.inputPlaceholder')}
          disabled={!isRunning}
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          className="h-8 gap-1.5"
          onClick={handleSend}
          disabled={!isRunning || input.length === 0}
        >
          <SendHorizontal className="size-3.5" />
          {t('detailPanel.sendInput')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={!isRunning}
          onClick={() => void sendBackgroundProcessInput(processId, '\u0003', false)}
        >
          {t('detailPanel.sendCtrlC')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-xs"
          disabled={!isRunning}
          onClick={() => void stopBackgroundProcess(processId)}
        >
          {t('detailPanel.stopProcess')}
        </Button>
      </div>
    </div>
  )
}

// ── Main DetailPanel ─────────────────────────────────────────────

export function DetailPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const content = useUIStore((s) => s.detailPanelContent)
  const closeDetailPanel = useUIStore((s) => s.closeDetailPanel)

  const title = content?.type === 'team'
    ? t('detailPanel.team')
    : content?.type === 'subagent'
      ? t('detailPanel.subAgent')
      : content?.type === 'terminal'
        ? t('detailPanel.terminal')
      : content?.type === 'document'
        ? content.title
        : content?.type === 'report'
          ? content.title
          : t('detailPanel.details')

  const icon = content?.type === 'team'
    ? <Users className="size-4 text-cyan-500" />
    : content?.type === 'subagent'
      ? <Bot className="size-4 text-violet-500" />
      : content?.type === 'terminal'
        ? <Terminal className="size-4 text-emerald-500" />
      : <FileText className="size-4 text-muted-foreground" />

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l bg-background/50 backdrop-blur-sm">
      {/* Header */}
      <div className="flex h-10 items-center gap-2 px-3">
        {icon}
        <span className="text-sm font-medium flex-1 truncate">{title}</span>
        <button
          onClick={closeDetailPanel}
          className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
          title={t('detailPanel.closePanel')}
        >
          <X className="size-4" />
        </button>
      </div>
      <Separator />

      {/* Content */}
      <div className="flex-1 overflow-auto p-3">
        <AnimatePresence mode="wait">
          {content?.type === 'team' && (
            <FadeIn key="team" className="h-full">
              <TeamDetailView />
            </FadeIn>
          )}

          {content?.type === 'subagent' && (
            <FadeIn key="subagent" className="h-full">
              <SubAgentDetailView toolUseId={content.toolUseId} inlineText={content.text} />
            </FadeIn>
          )}

          {content?.type === 'terminal' && (
            <FadeIn key="terminal" className="h-full">
              <TerminalDetailView processId={content.processId} />
            </FadeIn>
          )}

          {content?.type === 'document' && (
            <FadeIn key="document" className="h-full">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {content.content}
                </Markdown>
              </div>
            </FadeIn>
          )}

          {content?.type === 'report' && (
            <FadeIn key="report" className="h-full">
              <div className="space-y-3">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words">
                  {JSON.stringify(content.data, null, 2)}
                </pre>
              </div>
            </FadeIn>
          )}

          {!content && (
            <FadeIn key="empty" className="h-full flex flex-col items-center justify-center py-12 text-center">
              <FileText className="mb-3 size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('detailPanel.noContent')}</p>
            </FadeIn>
          )}
        </AnimatePresence>
      </div>
    </aside>
  )
}
