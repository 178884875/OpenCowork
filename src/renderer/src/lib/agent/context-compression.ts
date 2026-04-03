import { nanoid } from 'nanoid'
import type { UnifiedMessage, ProviderConfig, ContentBlock, AIModelConfig } from '../api/types'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import i18n from '@renderer/locales'

// --- Types ---

export interface CompressionConfig {
  enabled: boolean
  /** Model's max context token count */
  contextLength: number
  /** Full compression trigger threshold (default 0.8) */
  threshold: number
  /** Pre-compression (lightweight clearing) threshold (default 0.65) */
  preCompressThreshold?: number
}

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
}

// --- Constants ---

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9

/** Pre-compression: keep tool results from last N messages */
const TOOL_RESULT_KEEP_RECENT = 6
/** Placeholder for cleared tool results */
const CLEARED_TOOL_RESULT_PLACEHOLDER = i18n.t('contextCompression.clearedToolResult', {
  ns: 'agent'
})
/** Placeholder for cleared thinking blocks */
const CLEARED_THINKING_PLACEHOLDER = i18n.t('contextCompression.clearedThinking', { ns: 'agent' })
const COMPRESSION_SYSTEM_PROMPT = i18n.t('contextCompression.systemPrompt', { ns: 'agent' })

// --- Public API ---

export function clampCompressionThreshold(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
  }
  return Math.min(
    MAX_CONTEXT_COMPRESSION_THRESHOLD,
    Math.max(MIN_CONTEXT_COMPRESSION_THRESHOLD, value)
  )
}

export function resolveCompressionThreshold(
  modelConfig?: Pick<AIModelConfig, 'contextCompressionThreshold'> | null
): number {
  return clampCompressionThreshold(modelConfig?.contextCompressionThreshold)
}

export function resolveCompressionContextLength(
  modelConfig?: Pick<AIModelConfig, 'contextLength' | 'enableExtendedContextCompression'> | null
): number {
  const configuredContextLength =
    typeof modelConfig?.contextLength === 'number' && modelConfig.contextLength > 0
      ? modelConfig.contextLength
      : DEFAULT_CONTEXT_COMPRESSION_LIMIT

  if (configuredContextLength <= DEFAULT_CONTEXT_COMPRESSION_LIMIT) {
    return configuredContextLength
  }

  return modelConfig?.enableExtendedContextCompression
    ? configuredContextLength
    : DEFAULT_CONTEXT_COMPRESSION_LIMIT
}

/**
 * Check whether full compression should be triggered.
 */
export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  return inputTokens / config.contextLength >= config.threshold
}

/**
 * Check whether lightweight pre-compression (tool result + thinking clearing) should be triggered.
 * This fires at a lower threshold than full compression.
 */
export function shouldPreCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  const preThreshold = config.preCompressThreshold ?? 0.65
  const ratio = inputTokens / config.contextLength
  return ratio >= preThreshold && ratio < config.threshold
}

/**
 * Lightweight pre-compression: clear stale tool results and old thinking blocks.
 * No API call needed — just truncates content in-place.
 * Returns a new message array with stale content cleared.
 */
export function preCompressMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length <= TOOL_RESULT_KEEP_RECENT) return messages

  const cutoff = messages.length - TOOL_RESULT_KEEP_RECENT
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg // recent messages: keep as-is
    if (typeof msg.content === 'string') return msg

    const blocks = msg.content as ContentBlock[]
    let changed = false
    const newBlocks = blocks.map((block) => {
      // Clear old tool results
      if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (content.length > 200) {
          changed = true
          return { ...block, content: CLEARED_TOOL_RESULT_PLACEHOLDER }
        }
      }
      // Clear old thinking blocks
      if (block.type === 'thinking') {
        changed = true
        return { ...block, thinking: CLEARED_THINKING_PLACEHOLDER }
      }
      return block
    })

    return changed ? { ...msg, content: newBlocks } : msg
  })
}

/**
 * Compress messages into a single structured memory message.
 *
 * The resulting history is replaced by exactly one user message so future turns
 * continue from a single compressed context.
 */
export async function compressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  _preserveCount?: number,
  focusPrompt?: string,
  pinnedContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  const originalCount = messages.length

  if (originalCount < 2) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  const originalTaskMsg = findOriginalTaskMessage(messages)
  const serialized = serializeCompressionInput(messages, originalTaskMsg?.content, pinnedContext)
  const summary = await callSummarizer(serialized, providerConfig, signal, focusPrompt)

  const summaryMsg: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: i18n.t('contextCompression.summaryMessage', {
      ns: 'agent',
      count: originalCount,
      summary
    }),
    createdAt: Date.now()
  }

  return {
    messages: [summaryMsg],
    result: {
      compressed: true,
      originalCount,
      newCount: 1
    }
  }
}

// --- Internal helpers ---

/**
 * Find a clean Zone B start boundary that doesn't split tool exchanges.
 * Walk backwards from the initial boundary until no tool_result blocks reference
 * tool_use IDs that would be outside Zone B (i.e. in the compression zone).
 */
function serializeCompressionInput(
  messages: UnifiedMessage[],
  originalTaskContent?: UnifiedMessage['content'],
  pinnedContext?: string
): string {
  const parts: string[] = []

  if (originalTaskContent) {
    parts.push('## Original Task')
    parts.push(
      typeof originalTaskContent === 'string'
        ? originalTaskContent
        : serializeMessageContent(originalTaskContent)
    )
  }

  if (pinnedContext?.trim()) {
    parts.push('## Pinned Plan Context')
    parts.push(pinnedContext.trim())
  }

  parts.push('## Full Conversation History')
  parts.push(serializeMessages(messages))

  return parts.join('\n\n')
}

function serializeMessageContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'thinking':
          return ''
        case 'tool_use':
          return i18n.t('contextCompression.toolCallLog', {
            ns: 'agent',
            name: block.name,
            input: JSON.stringify(block.input).slice(0, 500)
          })
        case 'tool_result': {
          const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          return i18n.t('contextCompression.toolResultLog', {
            ns: 'agent',
            error: block.isError,
            content: result.length > 800 ? `${result.slice(0, 800)}\n... [truncated, ${result.length} chars total]` : result
          })
        }
        case 'image':
          return i18n.t('contextCompression.imageAttachment', { ns: 'agent' })
        case 'image_error':
          return `[Image error: ${block.message}]`
      }
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Find the user's first real message (not a team notification, not pure tool_result blocks).
 */
function findOriginalTaskMessage(messages: UnifiedMessage[]): UnifiedMessage | null {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    if (msg.source === 'team') continue
    // Skip messages that are purely tool_result blocks (no human text)
    if (Array.isArray(msg.content)) {
      const hasText = (msg.content as ContentBlock[]).some(
        (b) => b.type === 'text' || b.type === 'image'
      )
      if (!hasText) continue
    }
    return msg
  }
  return null
}

/**
 * Serialize messages into a readable text representation for the summarizer.
 */
function serializeMessages(messages: UnifiedMessage[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    const role = msg.role.toUpperCase()

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        parts.push(`[${role}]: ${msg.content}`)
      }
      continue
    }

    const blockText = serializeMessageContent(msg.content as ContentBlock[])
    if (blockText.trim()) {
      parts.push(`[${role}]: ${blockText}`)
    }
  }

  return parts.join('\n\n')
}

/**
 * Call the main model to produce a structured summary of the conversation.
 */
async function callSummarizer(
  serializedMessages: string,
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  focusPrompt?: string
): Promise<string> {
  const config: ProviderConfig = {
    ...providerConfig,
    systemPrompt: COMPRESSION_SYSTEM_PROMPT,
    // Disable thinking for compression — we want direct output
    thinkingEnabled: false
  }

  const focusInstruction = focusPrompt
    ? i18n.t('contextCompression.specialFocus', { ns: 'agent', focusPrompt })
    : ''

  const messages: UnifiedMessage[] = [
    {
      id: 'compress-req',
      role: 'user',
      content: i18n.t('contextCompression.compressRequest', {
        ns: 'agent',
        focusInstruction,
        content: serializedMessages
      }),
      createdAt: Date.now()
    }
  ]

  // Use a separate abort controller with timeout fallback
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 120_000) // 2 min max

  // Link parent signal
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout)
      abortController.abort()
    } else {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout)
          abortController.abort()
        },
        { once: true }
      )
    }
  }

  let result = ''
  try {
    result = await runSidecarTextRequest({
      provider: config,
      messages,
      signal: abortController.signal,
      maxIterations: 1
    })
  } finally {
    clearTimeout(timeout)
  }

  // Strip thinking tags if present (some models wrap output)
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  if (!result) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  return result
}
