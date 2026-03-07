import * as React from 'react'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { Users, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SlideIn } from '@renderer/components/animate-ui'
import type { EditableUserMessageDraft } from '@renderer/lib/image-attachments'
import type { UnifiedMessage } from '@renderer/lib/api/types'

interface MessageItemProps {
  sessionId: string
  messageId: string
  isStreaming?: boolean
  isLastUserMessage?: boolean
  onEditUserMessage?: (draft: EditableUserMessageDraft) => void
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
}

function getContentSignal(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') return `s:${content.length}:${content.slice(-32)}`
  const last = content[content.length - 1]
  if (!last) return 'a:0'
  if (last.type === 'text') return `a:${content.length}:t:${last.text.length}:${last.text.slice(-32)}`
  if (last.type === 'thinking') {
    return `a:${content.length}:h:${last.thinking.length}:${last.completedAt ?? 0}`
  }
  if (last.type === 'tool_use') {
    return `a:${content.length}:u:${last.id}:${JSON.stringify(last.input).length}`
  }
  if (last.type === 'tool_result') {
    return `a:${content.length}:r:${last.toolUseId}:${typeof last.content === 'string' ? last.content.length : last.content.length}`
  }
  if (last.type === 'image_error') return `a:${content.length}:e:${last.code}:${last.message.length}`
  return `a:${content.length}:i:${last.source.type}:${last.source.url ?? last.source.data?.length ?? 0}`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Render a teammate notification as a collapsible bar with smooth transition */
function TeamNotification({ content }: { content: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)

  // Extract the teammate name from the prefix "[Team message from X]:"
  const match = content.match(/^\[Team message from (.+?)\]:\n?/)
  const from = match?.[1] ?? 'teammate'
  const body = match ? content.slice(match[0].length) : content

  return (
    <div className="my-4 rounded-lg border border-cyan-500/30 bg-cyan-500/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer"
      >
        <Users className="size-3.5 text-cyan-500 shrink-0" />
        <span className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400">{from}</span>
        <span className="flex-1" />
        <ChevronDown
          className={`size-3.5 text-muted-foreground/50 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-cyan-500/20 px-3 py-2 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_h2]:text-sm [&_h2]:mt-3 [&_h2]:mb-1 [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0">
            <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageItemInner({
  sessionId,
  messageId,
  isStreaming,
  isLastUserMessage,
  onEditUserMessage,
  toolResults
}: MessageItemProps): React.JSX.Element | null {
  const message = useChatStore(
    useShallow((s) => {
      const current = s.sessions
        .find((session) => session.id === sessionId)
        ?.messages.find((item) => item.id === messageId)
      if (!current) return null
      return {
        id: current.id,
        role: current.role,
        content: current.content,
        createdAt: current.createdAt,
        usage: current.usage,
        source: current.source,
        contentSignal: getContentSignal(current.content),
        usageSignal: current.usage
          ? `${current.usage.inputTokens}:${current.usage.outputTokens}:${current.usage.totalDurationMs ?? 0}`
          : ''
      }
    })
  )

  if (!message) return null

  const inner = (() => {
    switch (message.role) {
      case 'user': {
        // Team notification messages (source: 'team') are rendered differently
        if (message.source === 'team') {
          return (
            <TeamNotification
              content={
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content)
              }
            />
          )
        }
        // Regular user message - pass content directly to UserMessage component
        // UserMessage will handle ContentBlock[] extraction and system-remind filtering
        return (
          <UserMessage
            content={message.content}
            isLast={isLastUserMessage}
            onEdit={onEditUserMessage}
          />
        )
      }
      case 'assistant':
        return (
          <AssistantMessage
            content={message.content}
            isStreaming={isStreaming}
            usage={message.usage}
            toolResults={toolResults}
            msgId={message.id}
          />
        )
      default:
        return null
    }
  })()

  if (!inner) return null

  return (
    <SlideIn className="group/ts relative" direction="up" offset={10} duration={0.3}>
      <span className="absolute -left-12 top-1 hidden group-hover/ts:block text-[10px] text-muted-foreground/40 whitespace-nowrap">
        {formatTime(message.createdAt)}
      </span>
      {inner}
    </SlideIn>
  )
}

function areToolResultsEqual(
  a?: Map<string, { content: ToolResultContent; isError?: boolean }>,
  b?: Map<string, { content: ToolResultContent; isError?: boolean }>
): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.size !== b.size) return false

  for (const [id, value] of a) {
    const other = b.get(id)
    if (!other) return false
    if (other.isError !== value.isError) return false
    if (other.content !== value.content) return false
  }

  return true
}

function areEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.messageId === next.messageId &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastUserMessage === next.isLastUserMessage &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    areToolResultsEqual(prev.toolResults, next.toolResults)
  )
}

export const MessageItem = React.memo(MessageItemInner, areEqual)
