import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore, type RightPanelTab } from '@renderer/stores/ui-store'
import { StepsPanel } from '@renderer/components/cowork/StepsPanel'
import { ArtifactsPanel } from '@renderer/components/cowork/ArtifactsPanel'
import { ContextPanel } from '@renderer/components/cowork/ContextPanel'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { SshFileExplorer } from '@renderer/components/ssh/SshFileExplorer'
import { TeamPanel } from '@renderer/components/cowork/TeamPanel'
import { PlanPanel } from '@renderer/components/cowork/PlanPanel'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence } from 'motion/react'
import { FadeIn } from '@renderer/components/animate-ui'
import { RightPanelHeader } from './RightPanelHeader'
import { RightPanelRail } from './RightPanelRail'
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_SECTION_DEFS,
  RIGHT_PANEL_TAB_DEFS,
  RIGHT_PANEL_RAIL_WIDTH,
  RIGHT_PANEL_RAIL_SLIM_WIDTH,
  clampRightPanelWidth
} from './right-panel-defs'

function SshFilesPanel({
  connectionId,
  rootPath
}: {
  connectionId: string
  rootPath?: string
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sessions = useSshStore((s) => s.sessions)
  const connect = useSshStore((s) => s.connect)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const connectedSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'connected'
  )
  const connectingSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'connecting'
  )
  const errorSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'error'
  )

  useEffect(() => {
    setError(null)
    setConnecting(false)
  }, [connectionId])

  useEffect(() => {
    if (connectedSession) {
      setConnecting(false)
      setError(null)
      return
    }
    if (errorSession) {
      setConnecting(false)
      setError(errorSession.error ?? t('connectionFailed'))
      return
    }
    if (connectingSession) {
      setConnecting(true)
      return
    }
    if (connecting || error) return

    let active = true
    setConnecting(true)
    connect(connectionId)
      .then((sessionId) => {
        if (!active) return
        if (!sessionId) {
          setError(t('connectionFailed'))
          setConnecting(false)
        }
      })
      .catch(() => {
        if (!active) return
        setError(t('connectionFailed'))
        setConnecting(false)
      })

    return () => {
      active = false
    }
  }, [
    connectedSession,
    connectingSession,
    connect,
    connecting,
    connectionId,
    error,
    errorSession,
    t
  ])

  if (connectedSession) {
    return (
      <div className="h-full overflow-hidden rounded-lg border border-border/50 bg-background/40">
        <SshFileExplorer
          sessionId={connectedSession.id}
          connectionId={connectionId}
          rootPath={rootPath}
        />
      </div>
    )
  }

  if (connecting || connectingSession) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-border/50 bg-background/40 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-amber-500" />
        {t('connecting')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-border/50 bg-background/40 text-xs text-muted-foreground">
        <span>{error}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => setError(null)}
        >
          {t('terminal.reconnect')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-border/50 bg-background/40 text-xs text-muted-foreground">
      {t('connecting')}
    </div>
  )
}

export function RightPanel({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const tab = useUIStore((s) => s.rightPanelTab)
  const section = useUIStore((s) => s.rightPanelSection)
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const setTab = useUIStore((s) => s.setRightPanelTab)
  const setSection = useUIStore((s) => s.setRightPanelSection)
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)

  const teamToolsEnabled = useSettingsStore((s) => s.teamToolsEnabled)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  )
  const hasPlan = usePlanStore((s) => {
    if (!activeSessionId) return false
    return Object.values(s.plans).some((p) => p.sessionId === activeSessionId)
  })
  const planMode = useUIStore((s) => s.planMode)

  const visibleTabs = useMemo(
    () =>
      RIGHT_PANEL_TAB_DEFS.filter((item) => teamToolsEnabled || item.value !== 'team').filter(
        (item) => hasPlan || planMode || item.value !== 'plan'
      ),
    [teamToolsEnabled, hasPlan, planMode]
  )

  const availableSections = useMemo(
    () =>
      RIGHT_PANEL_SECTION_DEFS.filter((sectionDef) =>
        visibleTabs.some((tabDef) => tabDef.section === sectionDef.value)
      ),
    [visibleTabs]
  )

  useEffect(() => {
    if (visibleTabs.length === 0) return
    if (visibleTabs.some((tabDef) => tabDef.value === tab)) return
    setTab(visibleTabs[0].value)
  }, [visibleTabs, tab, setTab])

  useEffect(() => {
    if (availableSections.length === 0) return
    if (availableSections.some((sectionDef) => sectionDef.value === section)) return
    setSection(availableSections[0].value)
  }, [availableSections, section, setSection])

  const activeTabDef = visibleTabs.find((t) => t.value === tab) ?? visibleTabs[0]

  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(rightPanelWidth)
  const [isDragging, setIsDragging] = useState(false)

  const targetPanelWidth = compact
    ? Math.min(rightPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH)
    : rightPanelWidth

  // Ensure rightPanelWidth has a valid initial value if it's somehow 0
  useEffect(() => {
    if (rightPanelWidth === 0) {
      setRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH)
    }
  }, [rightPanelWidth, setRightPanelWidth])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = startXRef.current - event.clientX
      const nextWidth = clampRightPanelWidth(startWidthRef.current + delta)
      setRightPanelWidth(nextWidth)
    }

    const handleMouseUp = (): void => {
      draggingRef.current = false
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, setRightPanelWidth])

  const startResize = (event: React.MouseEvent): void => {
    if (!rightPanelOpen) return
    event.preventDefault()
    draggingRef.current = true
    startXRef.current = event.clientX
    startWidthRef.current = rightPanelWidth
    setIsDragging(true)
  }

  const handleSelectTab = (nextTab: RightPanelTab): void => {
    setTab(nextTab)
  }

  const [isRailHovered, setIsRailHovered] = useState(false)

  return (
    <aside
      className="relative flex h-full shrink-0 z-10 transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ 
        width: rightPanelOpen 
          ? targetPanelWidth + RIGHT_PANEL_RAIL_WIDTH 
          : (isRailHovered ? RIGHT_PANEL_RAIL_WIDTH : RIGHT_PANEL_RAIL_SLIM_WIDTH)
      }}
    >
      {/* Rail is always visible or serves as the toggle area */}
      <RightPanelRail
        visibleTabs={visibleTabs}
        activeTab={tab}
        onSelectTab={handleSelectTab}
        isOpen={rightPanelOpen}
        onToggle={() => setRightPanelOpen(!rightPanelOpen)}
        onHoverChange={setIsRailHovered}
      />

      {/* Resize Handle */}
      {rightPanelOpen && (
        <div
          className="absolute left-0 top-0 z-[60] h-full w-1.5 cursor-col-resize hover:bg-primary/30 transition-colors"
          onMouseDown={startResize}
          style={{ left: RIGHT_PANEL_RAIL_WIDTH }}
        />
      )}

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}

      {/* Clipping Wrapper for content */}
      <div
        className={cn(
          'h-full overflow-hidden bg-background/40 backdrop-blur-sm transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
          rightPanelOpen ? 'opacity-100 pointer-events-auto' : 'w-0 opacity-0 pointer-events-none'
        )}
        style={{ width: rightPanelOpen ? targetPanelWidth : 0 }}
      >
        <div className="h-full border-l border-border/40" style={{ width: targetPanelWidth }}>
          {activeTabDef && (
            <div className="flex flex-col h-full w-full">
              <RightPanelHeader
                activeTabDef={activeTabDef}
                onClose={() => setRightPanelOpen(false)}
                t={t}
              />

              <div className="flex-1 overflow-auto bg-background/20 p-4">
                <AnimatePresence mode="wait">
                  {tab === 'steps' && (
                    <FadeIn key="steps" className="h-full">
                      <StepsPanel />
                    </FadeIn>
                  )}

                  {tab === 'team' && (
                    <FadeIn key="team" className="h-full">
                      <TeamPanel />
                    </FadeIn>
                  )}

                  {tab === 'files' && (
                    <FadeIn key="files" className="h-full">
                      {activeSession?.sshConnectionId ? (
                        <SshFilesPanel
                          connectionId={activeSession.sshConnectionId}
                          rootPath={activeSession.workingFolder}
                        />
                      ) : (
                        <FileTreePanel />
                      )}
                    </FadeIn>
                  )}

                  {tab === 'artifacts' && (
                    <FadeIn key="artifacts" className="h-full">
                      <ArtifactsPanel />
                    </FadeIn>
                  )}

                  {tab === 'context' && (
                    <FadeIn key="context" className="h-full">
                      <ContextPanel />
                    </FadeIn>
                  )}

                  {tab === 'plan' && (
                    <FadeIn key="plan" className="h-full">
                      <PlanPanel />
                    </FadeIn>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
