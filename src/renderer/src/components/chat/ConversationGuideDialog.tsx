import * as React from 'react'
import {
  BookOpen,
  FolderTree,
  MessageSquareText,
  AtSign,
  Slash,
  PanelRight,
  PlayCircle,
  ExternalLink,
  Sparkles
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/stores/settings-store'

interface ConversationGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface GuideSection {
  key: string
  icon: React.ReactNode
  title: string
  bullets: string[]
}

export function ConversationGuideDialog({
  open,
  onOpenChange
}: ConversationGuideDialogProps): React.JSX.Element {
  const { t } = useTranslation('chat')

  const markSeen = React.useCallback(() => {
    useSettingsStore.getState().updateSettings({ conversationGuideSeen: true })
  }, [])

  const sections = React.useMemo<GuideSection[]>(() => {
    const bulletKeys = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => t(`guide.sections.${prefix}.bullets.${index}`))

    return [
      {
        key: 'leftSidebar',
        icon: <FolderTree className="size-4 text-amber-500" />,
        title: t('guide.sections.leftSidebar.title'),
        bullets: bulletKeys('leftSidebar', 5)
      },
      {
        key: 'composer',
        icon: <MessageSquareText className="size-4 text-blue-500" />,
        title: t('guide.sections.composer.title'),
        bullets: bulletKeys('composer', 5)
      },
      {
        key: 'mentions',
        icon: <AtSign className="size-4 text-emerald-500" />,
        title: t('guide.sections.mentions.title'),
        bullets: bulletKeys('mentions', 4)
      },
      {
        key: 'commands',
        icon: <Slash className="size-4 text-violet-500" />,
        title: t('guide.sections.commands.title'),
        bullets: bulletKeys('commands', 4)
      },
      {
        key: 'rightPanel',
        icon: <PanelRight className="size-4 text-cyan-500" />,
        title: t('guide.sections.rightPanel.title'),
        bullets: bulletKeys('rightPanel', 6)
      },
      {
        key: 'quickStart',
        icon: <PlayCircle className="size-4 text-rose-500" />,
        title: t('guide.sections.quickStart.title'),
        bullets: bulletKeys('quickStart', 5)
      }
    ]
  }, [t])

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) markSeen()
    onOpenChange(nextOpen)
  }

  const handleStart = (): void => {
    markSeen()
    onOpenChange(false)
  }

  const handleOpenDocs = (): void => {
    window.open('https://open-cowork.shop/', '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b bg-muted/20 px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BookOpen className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-left text-xl">
                {t('guide.title')}
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                  <Sparkles className="size-3" />
                  {t('guide.badge')}
                </span>
              </DialogTitle>
              <p className="mt-1 text-sm text-muted-foreground">{t('guide.subtitle')}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-4 overflow-y-auto px-6 py-5 md:grid-cols-2">
          {sections.map((section) => (
            <section
              key={section.key}
              className="rounded-2xl border border-border/60 bg-background/80 p-4 shadow-sm"
            >
              <div className="mb-3 flex items-center gap-2">
                {section.icon}
                <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
              </div>
              <ul className="space-y-2">
                {section.bullets.map((bullet, index) => (
                  <li key={`${section.key}-${index}`} className="text-sm leading-6 text-muted-foreground">
                    {bullet}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <DialogFooter className="border-t bg-background px-6 py-4 sm:justify-between">
          <Button variant="outline" className="gap-1.5" onClick={handleOpenDocs}>
            <ExternalLink className="size-3.5" />
            {t('guide.openDocs')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('guide.close')}
            </Button>
            <Button onClick={handleStart}>{t('guide.startNow')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
