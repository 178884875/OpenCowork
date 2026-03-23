import {
  CircleHelp,
  Briefcase,
  Code2,
  Settings,
  Sun,
  Moon,
  Keyboard,
  Brain,
  Users,
  Terminal,
  Square,
  HelpCircle
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { cn } from '@renderer/lib/utils'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { WindowControls } from './WindowControls'

const modes: { value: AppMode; labelKey: string; icon: React.ReactNode }[] = [
  { value: 'clarify', labelKey: 'mode.clarify', icon: <CircleHelp className="size-4" /> },
  { value: 'cowork', labelKey: 'mode.cowork', icon: <Briefcase className="size-4" /> },
  { value: 'code', labelKey: 'mode.code', icon: <Code2 className="size-4" /> }
]

export function TopBar(): React.JSX.Element {
  const { t: tCommon } = useTranslation('common')
  const { t } = useTranslation('layout')
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen)
  const { theme, setTheme } = useTheme()

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSessionMode = useChatStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.mode
  )
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const autoApprove = useSettingsStore((s) => s.autoApprove)
  const clarifyAutoAcceptRecommended = useSettingsStore((s) => s.clarifyAutoAcceptRecommended)
  const pendingApprovals = useAgentStore((s) => s.pendingToolCalls.length)
  const errorCount = useAgentStore((s) =>
    s.executedToolCalls.reduce(
      (count, toolCall) => count + (toolCall.status === 'error' ? 1 : 0),
      0
    )
  )
  const runningSubAgentNamesSig = useAgentStore((s) => s.runningSubAgentNamesSig)
  const runningBackgroundCommandIdsSig = useAgentStore((s) =>
    Object.values(s.backgroundProcesses)
      .filter(
        (p) =>
          p.source === 'bash-tool' &&
          p.status === 'running' &&
          (!activeSessionId || p.sessionId === activeSessionId)
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => p.id)
      .join('\u0000')
  )
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const activeTeamSummary = useTeamStore(
    useShallow((s) => {
      const team = s.activeTeam
      if (!team) return null
      return {
        name: team.name,
        total: team.tasks.length,
        completed: team.tasks.filter((task) => task.status === 'completed').length,
        working: team.members.filter((member) => member.status === 'working').length
      }
    })
  )
  const runningSubAgentNames = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000')
    : []
  const runningBackgroundCommands = runningBackgroundCommandIdsSig
    ? runningBackgroundCommandIdsSig.split('\u0000').reduce(
        (list, id) => {
          const process = useAgentStore.getState().backgroundProcesses[id]
          if (process) list.push(process)
          return list
        },
        [] as Array<ReturnType<typeof useAgentStore.getState>['backgroundProcesses'][string]>
      )
    : []

  const toggleTheme = (): void => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  const handleToggleAutoApprove = async (): Promise<void> => {
    if (!autoApprove) {
      const ok = await confirm({ title: t('autoApproveConfirm') })
      if (!ok) return
    }

    useSettingsStore.getState().updateSettings({ autoApprove: !autoApprove })
    toast.success(t(autoApprove ? 'autoApproveOff' : 'autoApproveOn'))
  }

  return (
    <header className="titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-2 overflow-hidden border-b bg-background/80 backdrop-blur-md pl-4 pr-[132px]">
      <SidebarTrigger className="titlebar-no-drag shrink-0 -ml-1" />
      <div className="shrink-0 mr-2" />

      <div
        data-tour="mode-switch"
        className="titlebar-no-drag flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
      >
        {modes.map((m, i) => (
          <Tooltip key={m.value}>
            <TooltipTrigger asChild>
              <Button
                variant={mode === m.value ? 'secondary' : 'ghost'}
                size="sm"
                className={cn(
                  'titlebar-no-drag h-6 gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all duration-200',
                  mode === m.value
                    ? 'bg-background shadow-sm ring-1 ring-border/50'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => {
                  setMode(m.value)
                  if (activeSessionId) updateSessionMode(activeSessionId, m.value)
                }}
              >
                {m.icon}
                {tCommon(m.labelKey)}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {tCommon(m.labelKey)} (Ctrl+{i + 1})
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="flex-1" />

      {/* Right-side controls — must not shrink */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Clarify auto-accept recommended */}
        {(activeSessionMode === 'clarify' || mode === 'clarify') && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'titlebar-no-drag rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                  clarifyAutoAcceptRecommended
                    ? 'bg-emerald-500/12 text-emerald-500 hover:bg-emerald-500/20'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                )}
                onClick={() =>
                  useSettingsStore.getState().updateSettings({
                    clarifyAutoAcceptRecommended: !clarifyAutoAcceptRecommended
                  })
                }
              >
                {t('topbar.clarifyAutoAcceptShort')}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {clarifyAutoAcceptRecommended
                ? t('topbar.clarifyAutoAcceptOn')
                : t('topbar.clarifyAutoAcceptOff')}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Auto-approve toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={autoApprove}
              aria-label={autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')}
              className={cn(
                'titlebar-no-drag rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                autoApprove
                  ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              )}
              onClick={() => void handleToggleAutoApprove()}
            >
              AUTO
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')} ·{' '}
            {t('topbar.clickToSwitch')}
          </TooltipContent>
        </Tooltip>

        {/* Pending approval indicator */}
        {pendingApprovals > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="titlebar-no-drag animate-pulse rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400 cursor-default">
                {t('topbar.pendingCount', { count: pendingApprovals })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('topbar.toolCallAwaiting')}</TooltipContent>
          </Tooltip>
        )}

        {/* SubAgent indicator */}
        {runningSubAgentNames.length > 0 && (
          <span className="titlebar-no-drag flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-500">
            <Brain className="size-3 animate-pulse" />
            {runningSubAgentNames.join(', ')}
          </span>
        )}

        {/* Team indicator */}
        {activeTeamSummary && (
          <button
            onClick={() => {
              const ui = useUIStore.getState()
              ui.setRightPanelOpen(true)
              ui.setRightPanelTab('team')
            }}
            className="titlebar-no-drag flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-medium text-cyan-500 hover:bg-cyan-500/20 transition-colors"
          >
            <Users className="size-3" />
            {activeTeamSummary.name}
            {activeTeamSummary.total > 0 && (
              <span className="text-cyan-500/60">
                · {activeTeamSummary.completed}/{activeTeamSummary.total}✓
              </span>
            )}
            {activeTeamSummary.working > 0 && (
              <span className="flex items-center gap-0.5">
                <span className="size-1.5 rounded-full bg-cyan-500 animate-pulse" />
                {activeTeamSummary.working}
              </span>
            )}
          </button>
        )}

        {/* Error count indicator */}
        {errorCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="titlebar-no-drag rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive cursor-default">
                {t('topbar.errorsCount', { count: errorCount })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('topbar.toolCallsFailed', { count: errorCount })}</TooltipContent>
          </Tooltip>
        )}

        {/* Background command indicator */}
        {runningBackgroundCommands.length > 0 && (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="titlebar-no-drag h-7 gap-1.5 px-2 text-[10px]"
                    >
                      <Terminal className="size-3.5" />
                      {t('topbar.backgroundCommandsCount', {
                        count: runningBackgroundCommands.length
                      })}
                    </Button>
                  </PopoverTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('topbar.backgroundCommandsTooltip')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-[22rem] p-2">
              <div className="mb-1 text-xs font-medium text-foreground/85">
                {t('topbar.backgroundCommandsTitle', { count: runningBackgroundCommands.length })}
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {runningBackgroundCommands.map((proc) => (
                  <div key={proc.id} className="rounded-md border px-2 py-1.5">
                    <div className="truncate font-mono text-[11px] text-foreground/85">
                      {proc.command}
                    </div>
                    {proc.cwd && (
                      <div className="truncate text-[10px] text-muted-foreground/60">
                        {proc.cwd}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px] text-muted-foreground"
                        onClick={() => openDetailPanel({ type: 'terminal', processId: proc.id })}
                      >
                        {t('topbar.openSession')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 gap-1 px-1.5 text-[10px] text-destructive/80"
                        onClick={() => void stopBackgroundProcess(proc.id)}
                      >
                        <Square className="size-2.5 fill-current" />
                        {t('topbar.stopCommand')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Theme Toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="titlebar-no-drag size-7"
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.toggleTheme')}</TooltipContent>
        </Tooltip>

        {/* Keyboard Shortcuts */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="titlebar-no-drag size-7"
              onClick={() => setShortcutsOpen(true)}
            >
              <Keyboard className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.shortcuts')}</TooltipContent>
        </Tooltip>

        {/* Help */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon" className="titlebar-no-drag size-7">
              <a href="https://open-cowork.shop/" target="_blank" rel="noreferrer">
                <HelpCircle className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.help', { defaultValue: 'Help Center' })}</TooltipContent>
        </Tooltip>

        {/* Settings */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="titlebar-no-drag size-7"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.settings')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Window Controls — fixed to top-right so they are never clipped */}
      <div className="absolute right-0 top-0 z-10">
        <WindowControls />
      </div>
    </header>
  )
}
