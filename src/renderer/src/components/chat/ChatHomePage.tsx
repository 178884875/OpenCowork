import * as React from 'react'
import { useEffect, useState } from 'react'
import {
  CircleHelp,
  Briefcase,
  Code2,
  FolderOpen,
  Monitor,
  Server,
  Pencil,
  ChevronDown,
  Plus
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { InputArea } from '@renderer/components/chat/InputArea'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import appIconUrl from '../../../../../resources/icon.png'
import { Input } from '@renderer/components/ui/input'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  renderModeTooltipContent,
  type ModeOption,
  type SelectableMode
} from '@renderer/lib/mode-tooltips'
import { AnimatePresence, motion } from 'motion/react'

const modes: ModeOption[] = [
  { value: 'clarify', labelKey: 'mode.clarify', icon: <CircleHelp className="size-3.5" /> },
  { value: 'cowork', labelKey: 'mode.cowork', icon: <Briefcase className="size-3.5" /> },
  { value: 'code', labelKey: 'mode.code', icon: <Code2 className="size-3.5" /> }
]

const MODE_SWITCH_TRANSITION = {
  type: 'spring',
  stiffness: 320,
  damping: 26,
  mass: 0.7
} as const

const MODE_SWITCH_HIGHLIGHT_CLASS: Record<SelectableMode, string> = {
  clarify: 'border-amber-500/15 bg-amber-500/5 shadow-sm',
  cowork: 'border-emerald-500/15 bg-emerald-500/5 shadow-sm',
  code: 'border-violet-500/15 bg-violet-500/5 shadow-sm'
}

const MODE_SWITCH_ACTIVE_TEXT_CLASS: Record<SelectableMode, string> = {
  clarify: 'text-foreground',
  cowork: 'text-foreground',
  code: 'text-foreground'
}

const DEFAULT_SSH_WORKDIR = ''
interface DesktopDirectoryOption {
  name: string
  path: string
  isDesktop: boolean
}

interface DesktopDirectorySuccessResult {
  desktopPath: string
  directories: DesktopDirectoryOption[]
}

interface DesktopDirectoryErrorResult {
  error: string
}

type DesktopDirectoryResult = DesktopDirectorySuccessResult | DesktopDirectoryErrorResult

function formatContextLength(length?: number): string | null {
  if (!length) return null
  if (length >= 1_000_000) {
    return `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`
  }
  if (length >= 1_000) return `${Math.round(length / 1_000)}K`
  return String(length)
}

export function ChatHomePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const { t: tLayout } = useTranslation('layout')
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const projects = useChatStore((s) => s.projects)
  const sessions = useChatStore((s) => s.sessions)
  const setActiveProject = useChatStore((s) => s.setActiveProject)
  const createProject = useChatStore((s) => s.createProject)
  const ensureDefaultProject = useChatStore((s) => s.ensureDefaultProject)
  const updateProjectDirectory = useChatStore((s) => s.updateProjectDirectory)
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ??
    projects.find((project) => !project.pluginId) ??
    projects[0]
  const workingFolder = activeProject?.workingFolder
  const sshConnectionId = activeProject?.sshConnectionId
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [desktopDirectories, setDesktopDirectories] = useState<DesktopDirectoryOption[]>([])
  const [desktopDirectoriesLoading, setDesktopDirectoriesLoading] = useState(false)
  const { sendMessage } = useChatActions()
  const sshConnections = useSshStore((s) => s.connections)
  const sshLoaded = useSshStore((s) => s._loaded)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const providers = useProviderStore((s) => s.providers)
  const mainModelSelectionMode = useSettingsStore((s) => s.mainModelSelectionMode)
  const autoSelection = useUIStore((s) => s.getAutoModelSelection(activeSessionId))
  const [sshDirInputs, setSshDirInputs] = useState<Record<string, string>>({})
  const [sshDirEditingId, setSshDirEditingId] = useState<string | null>(null)

  const loadDesktopDirectories = React.useCallback(async (): Promise<void> => {
    if (mode === 'chat') return

    setDesktopDirectoriesLoading(true)
    try {
      const result = (await ipcClient.invoke(
        'fs:list-desktop-directories'
      )) as DesktopDirectoryResult
      if ('error' in result || !Array.isArray(result.directories)) {
        setDesktopDirectories([])
        return
      }

      const seen = new Set<string>()
      const deduped = result.directories.filter((directory) => {
        const key = directory.path.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setDesktopDirectories(deduped)
    } catch {
      setDesktopDirectories([])
    } finally {
      setDesktopDirectoriesLoading(false)
    }
  }, [mode])

  useEffect(() => {
    if (mode === 'chat') {
      setDesktopDirectories([])
      setFolderDialogOpen(false)
      return
    }
    void loadDesktopDirectories()
  }, [mode, loadDesktopDirectories])

  useEffect(() => {
    if (!folderDialogOpen) {
      setSshDirEditingId(null)
    }
  }, [folderDialogOpen])

  const resolveActiveProjectId = async (): Promise<string | null> => {
    if (activeProject?.id) return activeProject.id
    const project = await ensureDefaultProject()
    return project?.id ?? null
  }

  const handleOpenFolderDialog = (): void => {
    setFolderDialogOpen(true)
    void loadDesktopDirectories()
    if (!sshLoaded) void useSshStore.getState().loadAll()
  }

  const handleSelectDesktopFolder = (folderPath: string): void => {
    void (async () => {
      const projectId = await resolveActiveProjectId()
      if (!projectId) return
      updateProjectDirectory(projectId, {
        workingFolder: folderPath,
        sshConnectionId: null
      })
    })()
    setFolderDialogOpen(false)
  }

  const handleSelectOtherFolder = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (!result.canceled && result.path) {
      const projectId = await resolveActiveProjectId()
      if (!projectId) return
      updateProjectDirectory(projectId, {
        workingFolder: result.path,
        sshConnectionId: null
      })
      setFolderDialogOpen(false)
    }
  }

  const handleSelectSshFolder = (connId: string): void => {
    const conn = sshConnections.find((c) => c.id === connId)
    if (!conn) return
    const dir = sshDirInputs[connId]?.trim() || conn.defaultDirectory || DEFAULT_SSH_WORKDIR
    void (async () => {
      const projectId = await resolveActiveProjectId()
      if (!projectId) return
      updateProjectDirectory(projectId, {
        workingFolder: dir,
        sshConnectionId: connId
      })
    })()
    setSshDirEditingId(null)
    setFolderDialogOpen(false)
  }

  const handleCreateNewProject = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (!result.canceled && result.path) {
      // Use folder name as project name
      const folderName = result.path.split(/[\\/]/).pop() || 'New Project'
      const projectId = await createProject({
        name: folderName,
        workingFolder: result.path
      })
      setActiveProject(projectId)
    }
  }

  const handleSend = (text: string, images?: ImageAttachment[]): void => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.createSession(mode, activeProject?.id ?? undefined)
    chatStore.setActiveSession(sessionId)
    useUIStore.getState().navigateToSession()
    void sendMessage(text, images)
  }

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const sessionProviderId = activeSession?.providerId ?? null
  const sessionModelId = activeSession?.modelId ?? null
  const isSessionBound = Boolean(sessionProviderId && sessionModelId)
  const displayProviderId = sessionProviderId ?? activeProviderId
  const displayModelId = sessionModelId ?? activeModelId
  const displayProvider = providers.find((provider) => provider.id === displayProviderId)
  const displayModel = displayProvider?.models.find((model) => model.id === displayModelId)
  const isAutoModeActive = !isSessionBound && mainModelSelectionMode === 'auto'
  const autoResolvedProvider = autoSelection?.providerId
    ? providers.find((provider) => provider.id === autoSelection.providerId)
    : null
  const autoResolvedModel = autoResolvedProvider?.models.find(
    (model) => model.id === autoSelection?.modelId
  )
  const homeProvider = isAutoModeActive
    ? (autoResolvedProvider ?? displayProvider)
    : displayProvider
  const homeModel = isAutoModeActive ? (autoResolvedModel ?? displayModel) : displayModel
  const homeHasVision = modelSupportsVision(homeModel, homeProvider?.type)
  const homeHasTools = homeModel?.supportsFunctionCall === true
  const homeHasThinking = homeModel?.supportsThinking === true
  const homeModelTitle = isAutoModeActive
    ? autoSelection?.modelName
      ? `${tLayout('topbar.autoModel')} · ${autoSelection.modelName}`
      : tLayout('topbar.autoModel')
    : (homeModel?.name ?? displayModelId ?? t('messageList.homeModelUnavailable'))
  const homeTitle = {
    chat: t('messageList.homeTitleChat'),
    clarify: t('messageList.homeTitleClarify'),
    cowork: t('messageList.homeTitleCowork'),
    code: t('messageList.homeTitleCode')
  }[mode]

  let homeDescription = t('messageList.homeDescChatGeneral')
  if (isAutoModeActive) {
    homeDescription = {
      chat: t('messageList.homeDescAutoChat'),
      clarify: t('messageList.homeDescAutoClarify'),
      cowork: t('messageList.homeDescAutoCowork'),
      code: t('messageList.homeDescAutoCode')
    }[mode]
  } else if (mode === 'clarify') {
    homeDescription = homeHasThinking
      ? t('messageList.homeDescClarifyThinking')
      : t('messageList.homeDescClarifyGeneral')
  } else if (mode === 'cowork') {
    homeDescription = homeHasTools
      ? t('messageList.homeDescCoworkTools')
      : t('messageList.homeDescCoworkGeneral')
  } else if (mode === 'code') {
    homeDescription = homeHasThinking
      ? t('messageList.homeDescCodeThinking')
      : homeHasVision
        ? t('messageList.homeDescCodeVision')
        : t('messageList.homeDescCodeGeneral')
  } else {
    homeDescription = homeHasVision
      ? t('messageList.homeDescChatVision')
      : t('messageList.homeDescChatGeneral')
  }

  const homeModelMetaParts = [
    homeProvider?.name,
    homeHasVision ? tLayout('topbar.vision') : null,
    homeHasTools ? tLayout('topbar.tools') : null,
    homeHasThinking ? tLayout('topbar.thinking') : null,
    formatContextLength(homeModel?.contextLength)
  ].filter((value): value is string => Boolean(value))
  const homeModelMeta =
    homeModelMetaParts.join(' · ') || (isAutoModeActive ? t('messageList.homeAutoMeta') : '')

  const normalizedWorkingFolder = workingFolder?.toLowerCase()

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-gradient-to-b from-background via-background to-muted/20">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 py-8">
        <div className="mb-5 flex justify-center">
          <div className="flex items-center gap-0.5 rounded-xl border border-border/50 bg-background/95 p-0.5 shadow-md backdrop-blur-sm">
            {modes.map((m, i) => (
              <Tooltip key={m.value}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'relative h-8 gap-1.5 overflow-hidden rounded-lg px-3 text-xs font-medium transition-colors duration-200',
                      mode === m.value
                        ? cn(MODE_SWITCH_ACTIVE_TEXT_CLASS[m.value], 'font-semibold')
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setMode(m.value)}
                  >
                    <AnimatePresence initial={false}>
                      {mode === m.value && (
                        <motion.span
                          layoutId="home-mode-switch-highlight"
                          className={cn(
                            'pointer-events-none absolute inset-0 rounded-lg border',
                            MODE_SWITCH_HIGHLIGHT_CLASS[m.value]
                          )}
                          transition={MODE_SWITCH_TRANSITION}
                        />
                      )}
                    </AnimatePresence>
                    <span className="relative z-10 flex items-center gap-1.5">
                      {m.icon}
                      {tCommon(m.labelKey)}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  align="center"
                  sideOffset={8}
                  className="max-w-[340px] rounded-xl px-3 py-3"
                >
                  {renderModeTooltipContent({
                    mode: m.value,
                    labelKey: m.labelKey,
                    icon: m.icon,
                    shortcutIndex: i,
                    isActive: mode === m.value,
                    t: (key, options) => String(tLayout(key, options as never)),
                    tCommon: (key, options) => String(tCommon(key, options as never))
                  })}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>

        <div className="mb-5 flex min-h-[240px] flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center">
            <img
              src={appIconUrl}
              alt="OpenCowork"
              className="size-24 rounded-[28px] object-cover shadow-xl ring-1 ring-border/50"
            />
          </div>
          <div className="text-center">
            <p className="text-xs font-medium tracking-wide text-muted-foreground/80">
              {t('messageList.homeCurrentModel', { model: homeModelTitle })}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {homeTitle}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{homeDescription}</p>
            {homeModelMeta && (
              <p className="mt-1 text-xs text-muted-foreground/70">{homeModelMeta}</p>
            )}
          </div>
        </div>

        {mode !== 'chat' && (
          <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
            <DialogContent className="p-4 sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle className="text-sm">
                  {t('input.desktopFolders', { defaultValue: 'Desktop folders' })}
                </DialogTitle>
              </DialogHeader>

              <div className="-mt-1 rounded-xl border bg-background/60 p-3">
                <div className="mb-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
                  <p className="text-[10px] text-muted-foreground/70">
                    {t('input.currentWorkingFolder', {
                      defaultValue: 'Current working folder'
                    })}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <FolderOpen className="size-3 shrink-0" />
                    <span className="truncate">
                      {workingFolder ??
                        t('input.noWorkingFolderSelected', {
                          defaultValue: 'No folder selected'
                        })}
                    </span>
                  </div>
                </div>

                <div className="mb-2 flex items-center justify-end">
                  <button
                    className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                    onClick={() => void loadDesktopDirectories()}
                  >
                    {t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
                  </button>
                </div>

                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
                  {desktopDirectoriesLoading ? (
                    <span className="text-[11px] text-muted-foreground/60">
                      {t('input.loadingFolders', { defaultValue: 'Loading folders...' })}
                    </span>
                  ) : desktopDirectories.length > 0 ? (
                    desktopDirectories.map((directory) => {
                      const selected = directory.path.toLowerCase() === normalizedWorkingFolder
                      return (
                        <button
                          key={directory.path}
                          className={cn(
                            'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                            selected
                              ? 'border-primary/60 bg-primary/10 text-primary'
                              : 'border-border/70 bg-muted/20 text-muted-foreground hover:text-foreground hover:bg-muted/50'
                          )}
                          onClick={() => handleSelectDesktopFolder(directory.path)}
                          title={directory.path}
                        >
                          <FolderOpen className="size-3 shrink-0" />
                          <span className="max-w-[260px] truncate">{directory.name}</span>
                        </button>
                      )
                    })
                  ) : (
                    <span className="text-[11px] text-muted-foreground/60">
                      {t('input.noDesktopFolders', { defaultValue: 'No folders found on Desktop' })}
                    </span>
                  )}

                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    onClick={() => void handleSelectOtherFolder()}
                  >
                    <FolderOpen className="size-3 shrink-0" />
                    {t('input.selectOtherFolder', { defaultValue: 'Select other folder' })}
                  </button>
                </div>

                {/* SSH Connections */}
                <div className="mt-3 border-t pt-3">
                  <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70">
                    <Monitor className="size-3" />
                    {t('input.sshConnections', { defaultValue: 'SSH Connections' })}
                  </p>
                  {sshConnections.length > 0 ? (
                    <div className="space-y-1.5">
                      {sshConnections.map((conn) => {
                        const isSelected = sshConnectionId === conn.id
                        const dirValue =
                          sshDirInputs[conn.id] ?? conn.defaultDirectory ?? DEFAULT_SSH_WORKDIR
                        const displayDir = dirValue.trim() || DEFAULT_SSH_WORKDIR
                        const isEditingDir = sshDirEditingId === conn.id
                        return (
                          <div
                            key={conn.id}
                            className={cn(
                              'flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                              isSelected
                                ? 'border-primary/60 bg-primary/10'
                                : 'border-border/70 bg-muted/20 hover:bg-muted/50'
                            )}
                          >
                            <Server className="size-3 shrink-0 text-muted-foreground/60" />
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-medium truncate">{conn.name}</div>
                              <div className="text-[9px] text-muted-foreground/50 truncate">
                                {conn.username}@{conn.host}:{conn.port}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                className={cn(
                                  'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-all duration-200',
                                  isEditingDir
                                    ? 'max-w-0 opacity-0 -translate-x-1 pointer-events-none'
                                    : 'max-w-[180px] bg-background/40 hover:bg-muted/40'
                                )}
                                onClick={() => setSshDirEditingId(conn.id)}
                                title={displayDir}
                              >
                                <FolderOpen className="size-3 shrink-0" />
                                <span className="truncate">{displayDir}</span>
                              </button>
                              <div
                                className={cn(
                                  'overflow-hidden transition-all duration-200',
                                  isEditingDir
                                    ? 'max-w-[200px] opacity-100'
                                    : 'max-w-0 opacity-0 pointer-events-none'
                                )}
                              >
                                <Input
                                  value={dirValue}
                                  onChange={(e) =>
                                    setSshDirInputs((prev) => ({
                                      ...prev,
                                      [conn.id]: e.target.value
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSelectSshFolder(conn.id)
                                    if (e.key === 'Escape') setSshDirEditingId(null)
                                  }}
                                  placeholder={t('input.sshDirectoryPlaceholder', {
                                    defaultValue: '/home/user/project'
                                  })}
                                  className="h-6 w-40 text-[10px] bg-background/60"
                                />
                              </div>
                              <button
                                className={cn(
                                  'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors',
                                  isEditingDir
                                    ? 'border-primary/50 text-primary'
                                    : 'border-border/70 hover:text-foreground hover:bg-muted/50'
                                )}
                                onClick={() => setSshDirEditingId(isEditingDir ? null : conn.id)}
                              >
                                <Pencil className="size-3" />
                              </button>
                              <button
                                className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
                                onClick={() => handleSelectSshFolder(conn.id)}
                              >
                                {t('input.sshSelect', { defaultValue: 'Select' })}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/60">
                      {t('input.noSshConnections', {
                        defaultValue: 'No SSH connections configured'
                      })}
                    </span>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {/* Project selector (only for cowork/code modes) */}
        {mode !== 'chat' && (
          <div className="mx-auto mb-4 w-full max-w-3xl flex justify-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-2 text-xs">
                  <FolderOpen className="size-3.5" />
                  <span className="max-w-[200px] truncate">
                    {activeProject?.name ??
                      t('input.selectProject', { defaultValue: 'Select Project' })}
                  </span>
                  <ChevronDown className="size-3.5 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-[280px]">
                {projects
                  .filter((p) => !p.pluginId)
                  .map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() => setActiveProject(project.id)}
                      className="flex items-center gap-2"
                    >
                      <FolderOpen className="size-3.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{project.name}</div>
                        {project.workingFolder && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {project.workingFolder}
                          </div>
                        )}
                      </div>
                      {activeProject?.id === project.id && (
                        <div className="size-1.5 rounded-full bg-primary" />
                      )}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void handleCreateNewProject()}
                  className="flex items-center gap-2 text-primary"
                >
                  <Plus className="size-3.5" />
                  <span className="text-xs">
                    {t('input.newProject', { defaultValue: 'New Project' })}
                  </span>
                </DropdownMenuItem>
                {activeProject && (
                  <DropdownMenuItem
                    onClick={handleOpenFolderDialog}
                    className="flex items-center gap-2"
                  >
                    <Pencil className="size-3.5" />
                    <span className="text-xs">
                      {t('input.changeFolder', { defaultValue: 'Change Folder' })}
                    </span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* Input area */}
        <div className="mx-auto w-full max-w-3xl">
          <InputArea
            onSend={handleSend}
            onSelectFolder={mode !== 'chat' ? handleOpenFolderDialog : undefined}
            workingFolder={workingFolder}
            hideWorkingFolderIndicator
            isStreaming={false}
          />
        </div>

        {/* Keyboard shortcuts hint */}
        <div className="mx-auto mt-4 w-full max-w-3xl rounded-xl border bg-muted/30 px-5 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+N
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.newChat')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+K
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.commands')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+B
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.sidebarShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+/
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.shortcutsShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+,
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.settingsShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+D
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.duplicateShortcut')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
