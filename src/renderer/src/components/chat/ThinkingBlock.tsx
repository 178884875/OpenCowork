import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MONO_FONT } from '@renderer/lib/constants'
import {
  openMarkdownHref,
  resolveLocalFilePath,
  openLocalFilePath
} from '@renderer/lib/preview/viewers/markdown-components'
import { motion, AnimatePresence } from 'motion/react'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
  startedAt?: number
  completedAt?: number
}

export function ThinkingBlock({
  thinking,
  isStreaming = false,
  startedAt,
  completedAt
}: ThinkingBlockProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const isThinking = isStreaming && thinking.length > 0 && !completedAt

  const [expanded, setExpanded] = useState(false)
  const wasThinkingRef = useRef(isThinking)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [liveElapsed, setLiveElapsed] = useState(0)

  // Live timer while thinking
  useEffect(() => {
    if (!isThinking || !startedAt) return
    const tick = (): void => setLiveElapsed(Math.round((Date.now() - startedAt) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [isThinking, startedAt])

  useEffect(() => {
    const nextExpanded = isThinking ? true : wasThinkingRef.current && !isThinking ? false : null
    wasThinkingRef.current = isThinking
    if (nextExpanded === null) return
    setExpanded((prev) => (prev === nextExpanded ? prev : nextExpanded))
  }, [isThinking])

  // Auto-scroll to bottom while thinking is streaming
  useEffect(() => {
    if (isThinking && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [isThinking, thinking])

  // Compute duration label from persisted timestamps
  const persistedDuration =
    startedAt && completedAt ? Math.round((completedAt - startedAt) / 1000) : null

  const durationLabel =
    persistedDuration !== null
      ? t('thinking.thoughtFor', { seconds: persistedDuration })
      : isThinking && liveElapsed > 0
        ? t('thinking.thinkingFor', { seconds: liveElapsed })
        : isThinking
          ? t('thinking.thinkingEllipsis')
          : t('thinking.thoughts')

  return (
    <div className="my-5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors group"
      >
        <span className="group-hover:text-primary/80 transition-colors">{durationLabel}</span>
        {expanded ? (
          <ChevronDown className="size-3.5 transition-transform duration-200" />
        ) : (
          <ChevronRight className="size-3.5 transition-transform duration-200" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="overflow-hidden"
          >
            <div
              ref={scrollRef}
              className="mt-1.5 pl-2 border-l-2 border-muted text-sm text-muted-foreground/80 leading-relaxed max-h-80 overflow-y-auto"
            >
              {isThinking ? (
                <div className="whitespace-pre-wrap break-words">{thinking}</div>
              ) : (
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children, ...props }) => (
                      <a
                        {...props}
                        href={href}
                        className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
                        onClick={(event) => {
                          if (!href) return
                          const handled = openMarkdownHref(href)
                          if (handled) event.preventDefault()
                        }}
                      >
                        {children}
                      </a>
                    ),
                    code: ({ children, className, ...props }) => {
                      const isInline = !className
                      if (isInline) {
                        const code = String(children ?? '').replace(/\n$/, '')
                        const resolvedPath = resolveLocalFilePath(code)
                        if (resolvedPath) {
                          return (
                            <button
                              type="button"
                              className="cursor-pointer rounded bg-muted px-1 py-0.5 text-xs font-mono text-primary underline-offset-2 hover:underline"
                              style={{ fontFamily: MONO_FONT }}
                              title={resolvedPath}
                              onClick={() => {
                                void openLocalFilePath(code)
                              }}
                            >
                              {children}
                            </button>
                          )
                        }
                        return (
                          <code
                            className="rounded bg-muted px-1 py-0.5 text-xs font-mono"
                            style={{ fontFamily: MONO_FONT }}
                            {...props}
                          >
                            {children}
                          </code>
                        )
                      }
                      return (
                        <code className={className} style={{ fontFamily: MONO_FONT }} {...props}>
                          {children}
                        </code>
                      )
                    }
                  }}
                >
                  {thinking}
                </Markdown>
              )}
              {isThinking && (
                <span className="inline-block w-1.5 h-3.5 bg-primary/40 animate-pulse ml-0.5 rounded-sm" />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
