import type {
  ContentBlock,
  ThinkingBlock,
  ToolUseBlock,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { summarizeToolInputForHistory } from '@renderer/lib/tools/tool-input-sanitizer'
import { useUIStore } from '@renderer/stores/ui-store'
import { useBackgroundSessionStore } from '@renderer/stores/background-session-store'

function cloneMessage(message: UnifiedMessage): UnifiedMessage {
  try {
    return JSON.parse(JSON.stringify(message)) as UnifiedMessage
  } catch {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? (JSON.parse(JSON.stringify(message.content)) as UnifiedMessage['content'])
        : message.content,
      ...(message.usage ? { usage: JSON.parse(JSON.stringify(message.usage)) } : {})
    }
  }
}

function cloneContent<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

function isBufferedMessagePresent(sessionId: string, messageId: string): boolean {
  const session = useBackgroundSessionStore.getState().sessions[sessionId]
  if (!session) return false
  if (session.patchedMessagesById[messageId]) return true
  return session.addedMessages.some((message) => message.id === messageId)
}

function getOrCreateBufferedMessage(sessionId: string, messageId: string): UnifiedMessage | null {
  const backgroundStore = useBackgroundSessionStore.getState()
  backgroundStore.ensureSessionState(sessionId)

  const session = backgroundStore.sessions[sessionId]
  if (!session) return null

  const patched = session.patchedMessagesById[messageId]
  if (patched) return cloneMessage(patched)

  const added = session.addedMessages.find((message) => message.id === messageId)
  if (added) return cloneMessage(added)

  const source = useChatStore
    .getState()
    .getSessionMessages(sessionId)
    .find((message) => message.id === messageId)
  if (!source) return null

  return cloneMessage(source)
}

function commitBufferedMessage(sessionId: string, message: UnifiedMessage): void {
  const backgroundStore = useBackgroundSessionStore.getState()
  if (isBufferedMessagePresent(sessionId, message.id)) {
    const session = backgroundStore.sessions[sessionId]
    if (session?.patchedMessagesById[message.id]) {
      backgroundStore.upsertPatchedMessage(sessionId, message)
      return
    }

    backgroundStore.upsertAddedMessage(sessionId, message)
    return
  }

  backgroundStore.upsertPatchedMessage(sessionId, message)
}

function mutateBufferedMessage(
  sessionId: string,
  messageId: string,
  mutator: (message: UnifiedMessage) => void
): void {
  const message = getOrCreateBufferedMessage(sessionId, messageId)
  if (!message) return
  mutator(message)
  commitBufferedMessage(sessionId, message)
  useBackgroundSessionStore.getState().markSessionUpdate(sessionId)
}

export function getVisibleSessionIds(): Set<string> {
  const visibleSessionIds = new Set<string>()
  const { activeSessionId } = useChatStore.getState()
  const uiState = useUIStore.getState()

  if (activeSessionId) visibleSessionIds.add(activeSessionId)
  if (uiState.miniSessionWindowOpen && uiState.miniSessionWindowSessionId) {
    visibleSessionIds.add(uiState.miniSessionWindowSessionId)
  }

  return visibleSessionIds
}

export function isSessionForeground(sessionId: string): boolean {
  return getVisibleSessionIds().has(sessionId)
}

export function updateRuntimeMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<UnifiedMessage>
): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().updateMessage(sessionId, messageId, patch)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    Object.assign(message, cloneContent(patch))
  })
}

export function appendRuntimeTextDelta(sessionId: string, messageId: string, text: string): void {
  if (!text) return
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendTextDelta(sessionId, messageId, text)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') {
      message.content += text
      return
    }

    const blocks = message.content as ContentBlock[]
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === 'text') {
      lastBlock.text += text
    } else {
      blocks.push({ type: 'text', text })
    }
  })
}

export function appendRuntimeThinkingDelta(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  const cleanedThinking = stripThinkTagMarkers(thinking)
  if (!cleanedThinking) return
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendThinkingDelta(sessionId, messageId, cleanedThinking)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    const now = Date.now()
    if (typeof message.content === 'string') {
      message.content = [{ type: 'thinking', thinking: cleanedThinking, startedAt: now }]
      return
    }

    const blocks = message.content as ContentBlock[]
    let targetThinkingBlock: ThinkingBlock | null = null
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block.type === 'thinking' && !block.completedAt) {
        targetThinkingBlock = block
        break
      }
    }

    if (targetThinkingBlock) {
      targetThinkingBlock.thinking = stripThinkTagMarkers(
        `${targetThinkingBlock.thinking}${cleanedThinking}`
      )
    } else {
      blocks.push({ type: 'thinking', thinking: cleanedThinking, startedAt: now })
    }
  })
}

export function setRuntimeThinkingEncryptedContent(
  sessionId: string,
  messageId: string,
  encryptedContent: string,
  provider: 'anthropic' | 'openai-responses' | 'google'
): void {
  if (!encryptedContent) return
  if (isSessionForeground(sessionId)) {
    useChatStore
      .getState()
      .setThinkingEncryptedContent(sessionId, messageId, encryptedContent, provider)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    const now = Date.now()
    if (typeof message.content === 'string') {
      const existingText = message.content
      message.content = [
        {
          type: 'thinking',
          thinking: '',
          encryptedContent,
          encryptedContentProvider: provider,
          startedAt: now
        },
        ...(existingText ? [{ type: 'text' as const, text: existingText }] : [])
      ]
      return
    }

    const blocks = message.content as ContentBlock[]
    let targetThinkingBlock: ThinkingBlock | null = null
    let providerMatchedThinkingBlock: ThinkingBlock | null = null

    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block.type !== 'thinking') continue
      if (!block.encryptedContent) {
        targetThinkingBlock = block
        break
      }
      if (!providerMatchedThinkingBlock && block.encryptedContentProvider === provider) {
        providerMatchedThinkingBlock = block
      }
    }

    targetThinkingBlock = targetThinkingBlock ?? providerMatchedThinkingBlock
    if (targetThinkingBlock) {
      targetThinkingBlock.encryptedContent = encryptedContent
      targetThinkingBlock.encryptedContentProvider = provider
      return
    }

    blocks.push({
      type: 'thinking',
      thinking: '',
      encryptedContent,
      encryptedContentProvider: provider,
      startedAt: now
    })
  })
}

export function completeRuntimeThinking(sessionId: string, messageId: string): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().completeThinking(sessionId, messageId)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') return
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'thinking' && !block.completedAt) {
        block.completedAt = Date.now()
      }
    }
  })
}

export function appendRuntimeToolUse(
  sessionId: string,
  messageId: string,
  toolUse: ToolUseBlock
): void {
  const normalizedToolUse: ToolUseBlock = {
    ...toolUse,
    input: summarizeToolInputForHistory(toolUse.name, toolUse.input)
  }
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendToolUse(sessionId, messageId, normalizedToolUse)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content }, cloneContent(normalizedToolUse)]
      return
    }

    ;(message.content as ContentBlock[]).push(cloneContent(normalizedToolUse))
  })
}

export function updateRuntimeToolUseInput(
  sessionId: string,
  messageId: string,
  toolUseId: string,
  input: Record<string, unknown>
): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().updateToolUseInput(sessionId, messageId, toolUseId, input)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') return
    const block = (message.content as ContentBlock[]).find(
      (item) => item.type === 'tool_use' && (item as ToolUseBlock).id === toolUseId
    ) as ToolUseBlock | undefined
    if (block) {
      block.input = cloneContent(summarizeToolInputForHistory(block.name, input))
    }
  })
}

export function appendRuntimeContentBlock(
  sessionId: string,
  messageId: string,
  block: ContentBlock
): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendContentBlock(sessionId, messageId, block)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content }, cloneContent(block)]
      return
    }

    ;(message.content as ContentBlock[]).push(cloneContent(block))
  })
}

export function addRuntimeMessage(sessionId: string, message: UnifiedMessage): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().addMessage(sessionId, message)
    return
  }

  useBackgroundSessionStore.getState().upsertAddedMessage(sessionId, message)
  useBackgroundSessionStore.getState().markSessionUpdate(sessionId)
}

export async function flushBackgroundSessionToForeground(sessionId: string): Promise<void> {
  if (!sessionId) return
  const buffered = useBackgroundSessionStore.getState().sessions[sessionId]
  if (!buffered) return

  await useChatStore.getState().loadRecentSessionMessages(sessionId, true)
  const chatStore = useChatStore.getState()
  const existingMessageIds = new Set(
    chatStore.getSessionMessages(sessionId).map((message) => message.id)
  )

  for (const message of Object.values(buffered.patchedMessagesById)) {
    chatStore.updateMessage(sessionId, message.id, {
      content: cloneContent(message.content),
      ...(message.usage ? { usage: cloneContent(message.usage) } : {}),
      ...(message.providerResponseId ? { providerResponseId: message.providerResponseId } : {})
    })
  }

  for (const message of buffered.addedMessages) {
    if (existingMessageIds.has(message.id)) continue
    chatStore.addMessage(sessionId, cloneMessage(message))
    existingMessageIds.add(message.id)
  }

  useBackgroundSessionStore.getState().clearBufferedSession(sessionId)
}
