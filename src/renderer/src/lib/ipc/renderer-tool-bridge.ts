import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import type { ToolContext } from '@renderer/lib/tools/tool-types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { getInlineToolHandler } from '@renderer/lib/ipc/inline-tool-handler-registry'

// Stage 1: the sidecar now dynamically bridges any unknown tool to the
// renderer via ToolRegistry.Execute's fallback. The authoritative list of
// bridgeable tools is whatever `toolRegistry` knows about — MCP tools,
// plugin/channel tools, WebFetch/WebSearch, etc. all participate without a
// static whitelist.

let rendererToolBridgeAttached = false

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function toToolContext(record: Record<string, unknown>): ToolContext {
  const pluginChatTypeRaw = typeof record.pluginChatType === 'string' ? record.pluginChatType : undefined
  const pluginChatType =
    pluginChatTypeRaw === 'p2p' || pluginChatTypeRaw === 'group' ? pluginChatTypeRaw : undefined
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    workingFolder: typeof record.workingFolder === 'string' ? record.workingFolder : undefined,
    currentToolUseId:
      typeof record.currentToolUseId === 'string' ? record.currentToolUseId : undefined,
    agentRunId: typeof record.agentRunId === 'string' ? record.agentRunId : undefined,
    pluginId: typeof record.pluginId === 'string' ? record.pluginId : undefined,
    pluginChatId: typeof record.pluginChatId === 'string' ? record.pluginChatId : undefined,
    pluginChatType,
    pluginSenderId: typeof record.pluginSenderId === 'string' ? record.pluginSenderId : undefined,
    pluginSenderName:
      typeof record.pluginSenderName === 'string' ? record.pluginSenderName : undefined,
    sshConnectionId:
      typeof record.sshConnectionId === 'string' ? record.sshConnectionId : undefined,
    signal: new AbortController().signal,
    ipc: ipcClient
  }
}

function normalizeResultContent(content: unknown): unknown {
  return content === undefined ? '' : content
}

export function attachRendererToolBridge(): void {
  if (rendererToolBridgeAttached) return
  rendererToolBridgeAttached = true

  window.electron.ipcRenderer.on(
    'sidecar:renderer-tool-request',
    async (_event: unknown, payload: { requestId: string; method: string; params: unknown }) => {
      if (payload?.method !== 'renderer/tool-request' || !payload.requestId) return

      try {
        const params = normalizeRecord(payload.params)
        const toolNameRaw = String(params.toolName ?? '')
        const isApprovalProbe = toolNameRaw.endsWith('#requiresApproval')
        const toolName = isApprovalProbe
          ? toolNameRaw.slice(0, -'#requiresApproval'.length)
          : toolNameRaw

        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
        const handler = getInlineToolHandler(sessionId, toolName) ?? toolRegistry.get(toolName)
        if (!handler) {
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            ...(isApprovalProbe
              ? { result: { requiresApproval: false } }
              : { error: `Tool handler not registered: ${toolName}` })
          })
          return
        }

        const input = normalizeRecord(params.input)
        const ctx = toToolContext(params)

        if (isApprovalProbe) {
          const requiresApproval = handler.requiresApproval?.(input, ctx) ?? false
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            result: { requiresApproval }
          })
          return
        }

        const result = await handler.execute(input, ctx)
        const structuredResult =
          typeof result === 'string' || Array.isArray(result)
            ? { content: normalizeResultContent(result), isError: false }
            : normalizeRecord(result)
        await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
          requestId: payload.requestId,
          result: {
            content: normalizeResultContent(structuredResult.content),
            isError: structuredResult.isError === true,
            ...(typeof structuredResult.error === 'string' ? { error: structuredResult.error } : {})
          }
        })
      } catch (error) {
        await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
          requestId: payload.requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  )
}
