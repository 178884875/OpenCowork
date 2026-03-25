import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { motion } from 'motion/react'
import type { RightPanelTab } from '@renderer/stores/ui-store'
import type { RightPanelTabDef } from './right-panel-defs'
import { RIGHT_PANEL_RAIL_WIDTH } from './right-panel-defs'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useChatStore } from '@renderer/stores/chat-store'

interface RightPanelRailProps {
  visibleTabs: RightPanelTabDef[]
  activeTab: RightPanelTab
  onSelectTab: (tab: RightPanelTab) => void
  showTabs: boolean
  isExpanded: boolean
  onToggle: () => void
}

export function RightPanelRail({
  visibleTabs,
  activeTab,
  onSelectTab,
  showTabs,
  isExpanded,
  onToggle
}: RightPanelRailProps): React.JSX.Element {
  const { t } = useTranslation('layout')

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasUnreadPlan = usePlanStore((s) => {
    if (!activeSessionId) return false
    const plan = Object.values(s.plans).find((p) => p.sessionId === activeSessionId)
    return plan?.status === 'drafting'
  })

  return (
    <div
      className="relative flex flex-col items-center py-3 border-r border-border/40 bg-background/50 backdrop-blur-xl z-50 shrink-0 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ width: RIGHT_PANEL_RAIL_WIDTH }}
    >
      <div
        className={cn(
          'flex flex-1 flex-col items-center gap-4 transition-opacity duration-300',
          !showTabs && 'pointer-events-none opacity-0'
        )}
      >
        {visibleTabs.map((tabDef) => {
          const Icon = tabDef.icon
          const isActive = tabDef.value === activeTab
          const showDot = tabDef.value === 'plan' && hasUnreadPlan && !isExpanded

          return (
            <div key={tabDef.value} className="relative">
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'relative size-9 overflow-hidden rounded-xl',
                      isActive
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                    )}
                    aria-label={t(`rightPanel.${tabDef.labelKey}`)}
                    onClick={() => {
                      if (isExpanded && isActive) {
                        onToggle()
                        return
                      }
                      onSelectTab(tabDef.value)
                      if (!isExpanded) onToggle()
                    }}
                  >
                    <Icon className={cn('size-5', isActive && 'scale-110')} />

                    {showDot && (
                      <div className="absolute top-1 right-1 z-10 size-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] animate-pulse" />
                    )}
                  </Button>
                </TooltipTrigger>
              </Tooltip>
            </div>
          )
        })}
      </div>

      {/* Bottom Toggle Button */}
      <div className="mt-auto border-t border-border/20 pt-4">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label={isExpanded ? t('rightPanel.collapse') : t('rightPanel.expand')}
              onClick={onToggle}
            >
              <motion.div
                key={isExpanded ? 'open' : 'closed'}
                initial={false}
                animate={{ rotate: isExpanded ? 180 : 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              >
                <ChevronRight className="size-4" />
              </motion.div>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={12} className="text-xs font-medium">
            {isExpanded ? t('rightPanel.collapse') : t('rightPanel.expand')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
