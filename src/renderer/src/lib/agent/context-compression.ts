import { nanoid } from 'nanoid'
import type { UnifiedMessage, ProviderConfig, ContentBlock, AIModelConfig } from '../api/types'
import { createProvider } from '../api/provider'
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

/** Minimum recent messages to preserve verbatim */
const MIN_PRESERVE_COUNT = 4
/** Maximum recent messages to preserve verbatim */
const MAX_PRESERVE_COUNT = 10
/** Pre-compression: keep tool results from last N messages */
const TOOL_RESULT_KEEP_RECENT = 6
/** Placeholder for cleared tool results */
const CLEARED_TOOL_RESULT_PLACEHOLDER = i18n.t('contextCompression.clearedToolResult', { ns: 'agent' })
/** Placeholder for cleared thinking blocks */
const CLEARED_THINKING_PLACEHOLDER = i18n.t('contextCompression.clearedThinking', { ns: 'agent' })
const COMPRESSION_SYSTEM_PROMPT = i18n.t('contextCompression.systemPrompt', { ns: 'agent' })

// --- Public API ---

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
export function shouldCompress(
  inputTokens: number,
  config: CompressionConfig
): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  return inputTokens / config.contextLength >= config.threshold
}

/**
 * Check whether lightweight pre-compression (tool result + thinking clearing) should be triggered.
 * This fires at a lower threshold than full compression.
 */
export function shouldPreCompress(
  inputTokens: number,
  config: CompressionConfig
): boolean {
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
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
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
 * Compress messages using the main dialog model.
 *
 * Three-zone protection:
 * 1. Zone A: Original task message (user's first real message) — preserved verbatim
 * 2. Compression zone: Middle history — deep summary via main model
 * 3. Zone B: Last `preserveCount` messages — preserved verbatim
 *
 * Returns the new message array and compression stats.
 */
export async function compressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  preserveCount?: number,
  focusPrompt?: string,
  pinnedContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  const originalCount = messages.length

  // Adaptive preserve count: scale with message count, clamped to [MIN, MAX]
  const effectivePreserve = preserveCount ?? Math.min(
    MAX_PRESERVE_COUNT,
    Math.max(MIN_PRESERVE_COUNT, Math.floor(originalCount / 5))
  )

  // Not enough messages to compress (need at least zone A + something + zone B)
  if (originalCount <= effectivePreserve + 2) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  // --- Zone A: find user's first real message ---
  const originalTaskMsg = findOriginalTaskMessage(messages)
  const zoneACount = originalTaskMsg ? 1 : 0

  // --- Zone B: last preserveCount messages, adjusted to a clean tool boundary ---
  let zoneBStart = Math.max(zoneACount, originalCount - effectivePreserve)
  // Walk backwards to ensure Zone B doesn't start with orphaned tool_result blocks.
  // If the message at zoneBStart has tool_result refs to tool_use IDs outside Zone B,
  // extend Zone B backwards to include those messages.
  zoneBStart = findCleanBoundary(messages, zoneBStart, zoneACount)
  const zoneB = messages.slice(zoneBStart)

  // --- Compression zone: everything between A and B ---
  const compressionStart = zoneACount
  const compressionEnd = zoneBStart
  const toCompress = messages.slice(compressionStart, compressionEnd)

  if (toCompress.length === 0) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  // Serialize messages for the summarizer
  const serialized = serializeMessages(toCompress)

  // Call the main model to produce a structured summary
  const summary = await callSummarizer(serialized, providerConfig, signal, focusPrompt)

  // Build the compressed summary message
  const summaryMsg: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: i18n.t('contextCompression.summaryMessage', { ns: 'agent', count: toCompress.length, summary }),
    createdAt: Date.now()
  }

  // Assemble: [original task (optional)] + [pinned plan context (optional)] + [summary] + [recent messages]
  const newMessages: UnifiedMessage[] = []
  if (originalTaskMsg) {
    newMessages.push(originalTaskMsg)
  }
  // Inject pinned plan context so it survives compression
  if (pinnedContext) {
    newMessages.push({
      id: nanoid(),
      role: 'user',
      content: `[Pinned Plan Context — DO NOT compress or discard]\n\n${pinnedContext}`,
      createdAt: Date.now()
    })
  }
  newMessages.push(summaryMsg)
  newMessages.push(...zoneB)

  // Sanitize orphaned tool_use / tool_result pairs to avoid API errors
  const sanitized = sanitizeOrphanedToolBlocks(newMessages)

  return {
    messages: sanitized,
    result: {
      compressed: true,
      originalCount,
      newCount: sanitized.length
    }
  }
}

// --- Internal helpers ---

/**
 * Find a clean Zone B start boundary that doesn't split tool exchanges.
 * Walk backwards from the initial boundary until no tool_result blocks reference
 * tool_use IDs that would be outside Zone B (i.e. in the compression zone).
 */
function findCleanBoundary(messages: UnifiedMessage[], initialStart: number, minStart: number): number {
  let start = initialStart
  const maxRetries = 20 // safety limit

  for (let attempt = 0; attempt < maxRetries && start > minStart; attempt++) {
    // Collect all tool_use IDs within the candidate Zone B
    const zoneBToolUseIds = new Set<string>()
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      if (typeof msg.content === 'string') continue
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use' && block.id) zoneBToolUseIds.add(block.id)
      }
    }

    // Check if any tool_result in Zone B references a tool_use outside Zone B
    let hasOrphan = false
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      if (typeof msg.content === 'string') continue
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.toolUseId && !zoneBToolUseIds.has(block.toolUseId)) {
          hasOrphan = true
          break
        }
      }
      if (hasOrphan) break
    }

    if (!hasOrphan) return start // clean boundary found

    // Extend Zone B backwards by 2 messages (assistant tool_use + user tool_result pair)
    start = Math.max(minStart, start - 2)
  }

  return start
}

/**
 * After compression, Zone B messages may contain tool_result blocks referencing
 * tool_use IDs that were in the compressed zone (now gone), or tool_use blocks
 * whose results are missing. The API requires matching pairs.
 *
 * This function converts orphaned tool blocks to plain text blocks so the
 * information is not lost but the API won't reject the request.
 */
function sanitizeOrphanedToolBlocks(messages: UnifiedMessage[]): UnifiedMessage[] {
  // 1. Collect all tool_use IDs and all tool_result references
  const toolUseIds = new Set<string>()
  const toolResultRefs = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id)
      if (block.type === 'tool_result' && block.toolUseId) toolResultRefs.add(block.toolUseId)
    }
  }

  // 2. Find orphans
  const orphanedToolUseIds = new Set<string>() // tool_use without matching tool_result
  const orphanedResultRefs = new Set<string>() // tool_result without matching tool_use

  for (const id of toolUseIds) {
    if (!toolResultRefs.has(id)) orphanedToolUseIds.add(id)
  }
  for (const ref of toolResultRefs) {
    if (!toolUseIds.has(ref)) orphanedResultRefs.add(ref)
  }

  // No orphans — return as-is
  if (orphanedToolUseIds.size === 0 && orphanedResultRefs.size === 0) return messages

  // 3. Convert orphaned blocks to text blocks
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg
    const blocks = msg.content as ContentBlock[]
    let changed = false
    const newBlocks: ContentBlock[] = []

    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && orphanedToolUseIds.has(block.id)) {
        // Convert orphaned tool_use to text
        changed = true
        newBlocks.push({
          type: 'text',
          text: i18n.t('contextCompression.previousToolCall', { ns: 'agent', name: block.name, input: JSON.stringify(block.input).slice(0, 200) })
        } as ContentBlock)
      } else if (block.type === 'tool_result' && block.toolUseId && orphanedResultRefs.has(block.toolUseId)) {
        // Convert orphaned tool_result to text
        changed = true
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content
        newBlocks.push({
          type: 'text',
          text: i18n.t('contextCompression.previousToolResult', { ns: 'agent', error: block.isError, content: truncated })
        } as ContentBlock)
      } else {
        newBlocks.push(block)
      }
    }

    // If all blocks were converted and the message becomes empty, keep at least a placeholder
    if (newBlocks.length === 0) {
      newBlocks.push({ type: 'text', text: i18n.t('contextCompression.clearedDuringCompression', { ns: 'agent' }) } as ContentBlock)
    }

    return changed ? { ...msg, content: newBlocks } : msg
  }).filter((msg) => {
    // Remove messages that are now just empty text
    if (typeof msg.content === 'string') return msg.content.trim().length > 0
    return (msg.content as ContentBlock[]).length > 0
  })
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

    const blocks = msg.content as ContentBlock[]
    const blockParts: string[] = []

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) blockParts.push(block.text)
          break
        case 'thinking':
          // Skip thinking blocks — they are internal reasoning
          break
        case 'tool_use':
          blockParts.push(
            i18n.t('contextCompression.toolCallLog', { ns: 'agent', name: block.name, input: JSON.stringify(block.input).slice(0, 500) })
          )
          break
        case 'tool_result': {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
          // Aggressively truncate tool results — detailed content is not needed for summary
          const truncated = content.length > 800
            ? content.slice(0, 800) + `\n... [truncated, ${content.length} chars total]`
            : content
          blockParts.push(
            i18n.t('contextCompression.toolResultLog', { ns: 'agent', error: block.isError, content: truncated })
          )
          break
        }
        case 'image':
          blockParts.push(i18n.t('contextCompression.imageAttachment', { ns: 'agent' }))
          break
      }
    }

    if (blockParts.length > 0) {
      parts.push(`[${role}]: ${blockParts.join('\n')}`)
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
      content: i18n.t('contextCompression.compressRequest', { ns: 'agent', focusInstruction, content: serializedMessages }),
      createdAt: Date.now()
    }
  ]

  const provider = createProvider(config)

  // Use a separate abort controller with timeout fallback
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 120_000) // 2 min max

  // Link parent signal
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout)
      abortController.abort()
    } else {
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        abortController.abort()
      }, { once: true })
    }
  }

  let result = ''
  try {
    for await (const event of provider.sendMessage(
      messages,
      [], // no tools
      config,
      abortController.signal
    )) {
      if (event.type === 'text_delta' && event.text) {
        result += event.text
      }
    }
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
