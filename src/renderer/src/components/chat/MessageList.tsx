import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useShallow } from 'zustand/react/shallow'
import { MessageItem } from './MessageItem'
import { MessageSquare, Briefcase, Code2, RefreshCw, ArrowDown, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import {
  isEditableUserMessage,
  type EditableUserMessageDraft
} from '@renderer/lib/image-attachments'

const modeHints = {
  chat: {
    icon: <MessageSquare className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startConversation',
    descKey: 'messageList.startConversationDesc'
  },
  cowork: {
    icon: <Briefcase className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startCowork',
    descKey: 'messageList.startCoworkDesc'
  },
  code: {
    icon: <Code2 className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startCoding',
    descKey: 'messageList.startCodingDesc'
  }
}

interface MessageListProps {
  onRetry?: () => void
  onEditUserMessage?: (draft: EditableUserMessageDraft) => void
}

interface RenderableMessage {
  messageId: string
  isLastUserMessage: boolean
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
}

interface RenderableMessageMeta {
  messageIndex: number
  isLastUserMessage: boolean
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
}

interface RenderableMetaBuildResult {
  items: RenderableMessageMeta[]
  hasAssistantMessages: boolean
}

const EMPTY_MESSAGES: UnifiedMessage[] = []
const EMPTY_MESSAGE_IDS: string[] = []
const INITIAL_VISIBLE_MESSAGE_COUNT = 120
const LOAD_MORE_MESSAGE_STEP = 80

function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function isRealUserMessage(message: UnifiedMessage): boolean {
  return isEditableUserMessage(message)
}

function collectToolResults(
  blocks: ContentBlock[],
  target: Map<string, { content: ToolResultContent; isError?: boolean }>
): void {
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      target.set(block.toolUseId, { content: block.content, isError: block.isError })
    }
  }
}

function buildRenderableMessageMeta(
  messages: UnifiedMessage[],
  streamingMessageId: string | null
): RenderableMetaBuildResult {
  let lastRealUserIndex = -1
  if (!streamingMessageId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserMessage(messages[i])) {
        lastRealUserIndex = i
        break
      }
    }
  }

  const assistantToolResults = new Map<
    number,
    Map<string, { content: ToolResultContent; isError?: boolean }>
  >()
  let trailingToolResults:
    | Map<string, { content: ToolResultContent; isError?: boolean }>
    | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (isToolResultOnlyUserMessage(message)) {
      if (!trailingToolResults) trailingToolResults = new Map()
      collectToolResults(message.content as ContentBlock[], trailingToolResults)
      continue
    }

    if (
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      trailingToolResults &&
      trailingToolResults.size > 0
    ) {
      assistantToolResults.set(i, trailingToolResults)
    }
    trailingToolResults = undefined
  }

  const result: RenderableMessageMeta[] = []
  let hasAssistantMessages = false
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isToolResultOnlyUserMessage(message)) continue
    if (message.role === 'assistant') hasAssistantMessages = true

    result.push({
      messageIndex: i,
      isLastUserMessage: i === lastRealUserIndex,
      toolResults: assistantToolResults.get(i)
    })
  }
  return { items: result, hasAssistantMessages }
}

export function MessageList({ onRetry, onEditUserMessage }: MessageListProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { activeSessionId, streamingMessageId, activeSessionLoaded, activeSessionMessageCount, activeWorkingFolder } =
    useChatStore(
      useShallow((s) => {
        const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
        return {
          activeSessionId: s.activeSessionId,
          streamingMessageId: s.streamingMessageId,
          activeSessionLoaded: activeSession?.messagesLoaded ?? true,
          activeSessionMessageCount: activeSession?.messageCount ?? 0,
          activeWorkingFolder: activeSession?.workingFolder
        }
      })
    )
  const messageIds = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      return activeSession?.messages.map((message) => message.id) ?? EMPTY_MESSAGE_IDS
    })
  )
  const mode = useUIStore((s) => s.mode)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const isStreamingRef = React.useRef(false)
  isStreamingRef.current = !!streamingMessageId

  const messages = React.useMemo(
    () => (activeSessionId ? useChatStore.getState().getSessionMessages(activeSessionId) : EMPTY_MESSAGES),
    [activeSessionId, messageIds]
  )
  React.useEffect(() => {
    if (!activeSessionId) return
    void useChatStore.getState().loadRecentSessionMessages(activeSessionId)
  }, [activeSessionId])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const renderableMeta = React.useMemo(
    () => buildRenderableMessageMeta(messages, streamingMessageId),
    // Structural deps only: avoid re-running expensive content scan for each streaming text delta.
    [activeSessionId, streamingMessageId, messageIds]
  )
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_MESSAGE_COUNT)
  const visibleRenderableMeta = React.useMemo(() => {
    const startIndex = Math.max(0, renderableMeta.items.length - visibleCount)
    return renderableMeta.items.slice(startIndex)
  }, [renderableMeta.items, visibleCount])
  const visibleRenderableMessages = React.useMemo<RenderableMessage[]>(() => {
    const result: RenderableMessage[] = []
    for (const item of visibleRenderableMeta) {
      const message = messages[item.messageIndex]
      if (!message || isToolResultOnlyUserMessage(message)) continue
      result.push({
        messageId: message.id,
        isLastUserMessage: item.isLastUserMessage,
        toolResults: item.toolResults
      })
    }
    return result
  }, [visibleRenderableMeta, messages])
  const hiddenLoadedMessageCount = Math.max(0, renderableMeta.items.length - visibleRenderableMeta.length)
  const olderUnloadedMessageCount = Math.max(0, activeSessionMessageCount - messages.length)
  const hiddenMessageCount = hiddenLoadedMessageCount + olderUnloadedMessageCount
  const contentRef = React.useRef<HTMLDivElement>(null)
  const hasAssistantMessages = renderableMeta.hasAssistantMessages

  React.useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_MESSAGE_COUNT)
    setIsAtBottom(true)
  }, [activeSessionId])

  React.useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !activeSessionId) return
    const scroll = (): void => {
      container.scrollTop = container.scrollHeight
    }
    scroll()
    const id = setTimeout(scroll, 100)
    if (content) {
      const observer = new ResizeObserver(() => scroll())
      observer.observe(content)
      const stopObserving = setTimeout(() => observer.disconnect(), 500)
      return () => {
        clearTimeout(id)
        clearTimeout(stopObserving)
        observer.disconnect()
      }
    }
    return () => clearTimeout(id)
  }, [activeSessionId, messageIds])

  // Track if user is near the bottom via scroll position
  // Use larger threshold during streaming so rapid content growth doesn't break auto-scroll
  React.useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = (): void => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      const threshold = isStreamingRef.current ? 150 : 5
      const nextAtBottom = distanceFromBottom <= threshold
      setIsAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom))
    }

    handleScroll()
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [activeSessionId])

  // Auto-scroll to bottom on new messages, streaming content, and tool call state changes
  React.useEffect(() => {
    if (!isAtBottom) return
    const container = scrollContainerRef.current
    if (!container) return

    if (isStreamingRef.current) {
      container.scrollTop = container.scrollHeight
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messageIds.length, streamingMessageId, isAtBottom])

  React.useEffect(() => {
    if (!streamingMessageId) return
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const observer = new ResizeObserver(() => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      if (distanceFromBottom <= 150) {
        container.scrollTop = container.scrollHeight
      }
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [streamingMessageId])

  const scrollToBottom = React.useCallback(() => {
    const container = scrollContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [])

  if (!activeSessionLoaded && activeSessionMessageCount > 0) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground/70">
        <Loader2 className="size-4 animate-spin" />
        <span>{t('common.loading', { ns: 'common', defaultValue: 'Loading...' })}</span>
      </div>
    )
  }

  if (messages.length === 0) {
    const hint = modeHints[mode]
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-muted/40 p-4">{hint.icon}</div>
          <div>
            <p className="text-base font-semibold text-foreground/80">{t(hint.titleKey)}</p>
            <p className="mt-1.5 text-sm text-muted-foreground/60 max-w-[320px]">
              {t(hint.descKey)}
            </p>
          </div>
        </div>
        {mode !== 'chat' && (
          <p className="text-[11px] text-muted-foreground/40">{t('messageList.tipDropFiles')}</p>
        )}
        <div className="flex flex-wrap justify-center gap-2 max-w-[400px]">
          {(mode === 'chat'
            ? [
                t('messageList.explainAsync'),
                t('messageList.compareRest'),
                t('messageList.writeRegex')
              ]
            : mode === 'cowork'
              ? activeWorkingFolder
                ? [
                    t('messageList.summarizeProject'),
                    t('messageList.findBugs'),
                    t('messageList.addErrorHandling')
                  ]
                : [
                    t('messageList.reviewCodebase'),
                    t('messageList.addTests'),
                    t('messageList.refactorError')
                  ]
              : activeWorkingFolder
                ? [
                    t('messageList.addFeature'),
                    t('messageList.writeTestsExisting'),
                    t('messageList.optimizePerformance')
                  ]
                : [
                    t('messageList.buildCli'),
                    t('messageList.createRestApi'),
                    t('messageList.writeScript')
                  ]
          ).map((prompt) => (
            <button
              key={prompt}
              className="rounded-lg border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={() => {
                const textarea = document.querySelector('textarea')
                if (textarea) {
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype,
                    'value'
                  )?.set
                  nativeInputValueSetter?.call(textarea, prompt)
                  textarea.dispatchEvent(new Event('input', { bubbles: true }))
                  textarea.focus()
                }
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
        <div className="mt-1 rounded-xl border bg-muted/30 px-5 py-3">
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
    )
  }

  return (
    <div className="relative flex-1" data-message-list>
      <div ref={scrollContainerRef} className="absolute inset-0 overflow-y-auto">
        <div
          ref={contentRef}
          data-message-content
          className="mx-auto max-w-3xl space-y-6 p-4 overflow-hidden"
        >
          {hiddenMessageCount > 0 && (
            <div className="flex justify-center">
              <button
                className="rounded-md border px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                onClick={() => {
                  if (hiddenLoadedMessageCount > 0) {
                    setVisibleCount((prev) => prev + LOAD_MORE_MESSAGE_STEP)
                    return
                  }
                  if (!activeSessionId || olderUnloadedMessageCount === 0) return
                  void useChatStore
                    .getState()
                    .loadOlderSessionMessages(activeSessionId, LOAD_MORE_MESSAGE_STEP)
                    .then((loaded) => {
                      if (loaded > 0) {
                        setVisibleCount((prev) => prev + loaded)
                      }
                    })
                }}
              >
                {t('messageList.loadMoreMessages', { defaultValue: '加载更早消息' })} (
                {hiddenMessageCount})
              </button>
            </div>
          )}
          {visibleRenderableMessages.map(({ messageId, isLastUserMessage, toolResults }) => {
            return (
              <MessageItem
                key={messageId}
                sessionId={activeSessionId ?? ''}
                messageId={messageId}
                isStreaming={messageId === streamingMessageId}
                isLastUserMessage={isLastUserMessage}
                onEditUserMessage={onEditUserMessage}
                toolResults={toolResults}
              />
            )
          })}
          {!streamingMessageId && messageIds.length > 0 && hasAssistantMessages && onRetry && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-muted-foreground"
                onClick={onRetry}
              >
                <RefreshCw className="size-3" />
                {t('action.retry', { ns: 'common' })}
              </Button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Scroll to bottom button */}
      {!isAtBottom && messageIds.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border bg-background/90 backdrop-blur-sm px-3 py-1.5 text-xs text-muted-foreground shadow-lg hover:text-foreground hover:shadow-xl transition-all duration-200 hover:-translate-y-0.5"
        >
          <ArrowDown className="size-3" />
          {t('messageList.scrollToBottom')}
        </button>
      )}
    </div>
  )
}
