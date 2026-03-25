import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Loader2, Save, ChevronRight, PanelLeftOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { ChannelPanel } from '@renderer/components/settings/PluginPanel'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { joinFsPath } from '@renderer/lib/agent/memory-files'

function isMissingFileError(message: string): boolean {
  return /ENOENT|No such file/i.test(message)
}

export function ProjectArchivePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projects = useChatStore((state) => state.projects)
  const leftSidebarOpen = useUIStore((state) => state.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((state) => state.toggleLeftSidebar)
  const chatView = useUIStore((state) => state.chatView)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeTab = chatView === 'channels' ? 'channels' : 'archive'

  const archivePath = useMemo(() => {
    if (!activeProject?.workingFolder) return null
    return joinFsPath(activeProject.workingFolder, 'AGENTS.md')
  }, [activeProject?.workingFolder])

  const loadArchive = useCallback(async () => {
    if (!activeProject) {
      setLoading(false)
      setError(null)
      setContent('')
      setSavedContent('')
      return
    }
    if (!archivePath) {
      setLoading(false)
      setError(null)
      setContent('')
      setSavedContent('')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = activeProject.sshConnectionId
        ? await ipcClient.invoke(IPC.SSH_FS_READ_FILE, {
            connectionId: activeProject.sshConnectionId,
            path: archivePath
          })
        : await ipcClient.invoke(IPC.FS_READ_FILE, { path: archivePath })

      if (typeof result === 'string') {
        setContent(result)
        setSavedContent(result)
        return
      }

      const nextError =
        result && typeof result === 'object' && 'error' in result
          ? String((result as { error?: unknown }).error ?? '')
          : 'Failed to load AGENTS.md'

      if (isMissingFileError(nextError)) {
        setContent('')
        setSavedContent('')
        return
      }

      setError(nextError)
      setContent('')
      setSavedContent('')
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError)
      if (isMissingFileError(message)) {
        setContent('')
        setSavedContent('')
        setError(null)
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }, [activeProject, archivePath])

  useEffect(() => {
    void loadArchive()
  }, [loadArchive])

  const handleSave = useCallback(async () => {
    if (!activeProject || !archivePath) return
    setSaving(true)
    setError(null)
    try {
      const result = activeProject.sshConnectionId
        ? await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
            connectionId: activeProject.sshConnectionId,
            path: archivePath,
            content
          })
        : await ipcClient.invoke(IPC.FS_WRITE_FILE, {
            path: archivePath,
            content
          })

      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String((result as { error?: unknown }).error ?? 'Failed to save AGENTS.md'))
      }

      setSavedContent(content)
      toast.success(t('projectArchive.saved', { defaultValue: '项目档案已保存' }))
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError)
      setError(message)
      toast.error(t('projectArchive.saveFailed', { defaultValue: '保存项目档案失败' }), {
        description: message
      })
    } finally {
      setSaving(false)
    }
  }, [activeProject, archivePath, content, t])

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="text-xl font-semibold text-foreground">
            {t('projectArchive.noProjectTitle', { defaultValue: '未选择项目' })}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('projectArchive.noProjectDesc', {
              defaultValue: '先返回首页选择项目，再查看项目档案。'
            })}
          </p>
          <Button className="mt-4" onClick={() => useUIStore.getState().navigateToHome()}>
            <ChevronRight className="size-4" />
            {t('projectArchive.backHome', { defaultValue: '返回首页' })}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-gradient-to-b from-background via-background to-muted/20 px-6 py-6">
      {!leftSidebarOpen && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-4 top-4 z-10 size-8 rounded-lg border border-border/60 bg-background/80 backdrop-blur-sm"
          onClick={toggleLeftSidebar}
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      )}
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-3xl border border-border/60 bg-background/70 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.55)] backdrop-blur-sm">
          {activeTab === 'channels' ? (
            <div className="min-h-0 flex-1 p-4">
              <ChannelPanel projectId={activeProjectId ?? undefined} />
            </div>
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {t('projectArchive.loading', { defaultValue: '正在加载项目档案...' })}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-3 text-sm">
                <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <FileText className="size-4 shrink-0" />
                  <span className="truncate">{archivePath || 'AGENTS.md'}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="text-xs text-muted-foreground">
                    {content === savedContent
                      ? t('projectArchive.savedState', { defaultValue: '内容已同步' })
                      : t('projectArchive.unsavedState', { defaultValue: '有未保存更改' })}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => useUIStore.getState().navigateToProject()}>
                    {t('projectArchive.backProject', { defaultValue: '返回项目主页' })}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleSave()}
                    disabled={saving || loading || !archivePath || content === savedContent}
                  >
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    {tCommon('action.save', { defaultValue: '保存' })}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 p-4">
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={t('projectArchive.placeholder', {
                    defaultValue: '# AGENTS.md\n\n在这里编写项目级工作协议、边界和协作说明。'
                  })}
                  className="h-full min-h-full resize-none border-0 bg-transparent px-0 py-0 font-mono text-sm leading-6 shadow-none focus-visible:ring-0"
                />
              </div>
              {error && (
                <div className="border-t px-5 py-3 text-sm text-destructive">
                  {t('projectArchive.errorLabel', { defaultValue: '错误：' })}
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
