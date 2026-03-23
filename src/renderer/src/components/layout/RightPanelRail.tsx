import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { RightPanelTab } from '@renderer/stores/ui-store'
import type { RightPanelTabDef } from './right-panel-defs'
import { RIGHT_PANEL_RAIL_WIDTH, RIGHT_PANEL_RAIL_SLIM_WIDTH } from './right-panel-defs'

import { usePlanStore } from '@renderer/stores/plan-store'
import { useChatStore } from '@renderer/stores/chat-store'

interface RightPanelRailProps {
  visibleTabs: RightPanelTabDef[]
  activeTab: RightPanelTab
  onSelectTab: (tab: RightPanelTab) => void
  isOpen: boolean
  onToggle: () => void
  onHoverChange?: (isHovered: boolean) => void
}

export function RightPanelRail({
  visibleTabs,
  activeTab,
  onSelectTab,
  isOpen,
  onToggle,
  onHoverChange
}: RightPanelRailProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [isHovered, setIsHovered] = useState(false)
  const [hoveredTab, setHoveredTab] = useState<RightPanelTab | null>(null)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    setIsHovered(true)
    onHoverChange?.(true)
  }

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false)
      onHoverChange?.(false)
      setHoveredTab(null)
    }, 300)
  }

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasUnreadPlan = usePlanStore((s) => {
    if (!activeSessionId) return false
    const plan = Object.values(s.plans).find((p) => p.sessionId === activeSessionId)
    return plan && plan.status === 'pending'
  })

  // Determine if we should show full rail or slim rail
  const showFullRail = isOpen || isHovered

  return (
    <div
      className={cn(
        'relative flex flex-col items-center py-3 border-l border-border/40 bg-background/80 backdrop-blur-xl z-50 shrink-0 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
        !isOpen && 'shadow-[-8px_0_20px_rgba(0,0,0,0.08)]'
      )}
      style={{ width: showFullRail ? RIGHT_PANEL_RAIL_WIDTH : RIGHT_PANEL_RAIL_SLIM_WIDTH }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={cn(
        "flex flex-1 flex-col items-center gap-4 transition-opacity duration-300",
        !showFullRail && "opacity-0"
      )}>
        {visibleTabs.map((tabDef) => {
          const Icon = tabDef.icon
          const isActive = tabDef.value === activeTab
          const showDot = tabDef.value === 'plan' && hasUnreadPlan && !isOpen

          return (
            <div
              key={tabDef.value}
              onMouseEnter={() => setHoveredTab(tabDef.value)}
              className="relative"
            >
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'size-9 rounded-xl transition-all duration-300 relative group overflow-hidden',
                      isActive
                        ? 'bg-primary/15 text-primary shadow-[0_0_12px_rgba(var(--primary),0.2)]'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/80'
                    )}
                    onClick={() => {
                      if (isActive) {
                        onToggle()
                      } else {
                        onSelectTab(tabDef.value)
                        if (!isOpen) onToggle()
                      }
                    }}
                  >
                    <Icon className={cn(
                      'size-5 transition-all duration-300',
                      isActive ? 'scale-110 rotate-0' : 'group-hover:scale-110 group-hover:rotate-3'
                    )} />
                    
                    {/* Unread Indicator Dot */}
                    {showDot && (
                      <div className="absolute top-1 right-1 size-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] animate-pulse z-10" />
                    )}

                    {/* Active Indicator Dot */}
                    {isActive && isOpen && (
                      <motion.div 
                        layoutId="activeTabIndicator"
                        className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-4 bg-primary rounded-r-full"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      />
                    )}

                    {/* Subtle pulse for active or processing tabs (placeholder logic) */}
                    {isActive && isOpen && (
                      <div className="absolute inset-0 bg-primary/5 animate-pulse" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={12} className="text-xs font-semibold bg-popover/90 backdrop-blur-md border-border/50">
                  {t(`rightPanel.${tabDef.labelKey}`)}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </div>

      {/* Slim indicator when collapsed and not hovered */}
      {!showFullRail && (
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-8 py-10 opacity-40">
        </div>
      )}
    </div>
  )
}
