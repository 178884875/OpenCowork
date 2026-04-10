import { createProvider } from '@renderer/lib/api/provider'
import type {
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage
} from '@renderer/lib/api/types'

// The sidecar's BridgedProvider delegates streaming requests here. The bridge
// keeps the .NET agent loop in control while letting us reuse the renderer's
// existing provider modules for any provider type the sidecar doesn't natively
// implement.

let rendererProviderBridgeAttached = false

type ProviderStreamStartPayload = {
  requestId: string
  method: string
  params: {
    streamId?: string
    providerType?: string
    providerConfig?: ProviderConfig
    messages?: UnifiedMessage[]
    tools?: ToolDefinition[]
    agentRunId?: string
    sessionId?: string
  }
}

function sendStreamEvent(streamId: string, event: StreamEvent): void {
  window.electron.ipcRenderer.send('sidecar:provider-stream-event', {
    streamId,
    event
  })
}

function sendStreamDone(streamId: string, error?: string): void {
  window.electron.ipcRenderer.send('sidecar:provider-stream-event', {
    streamId,
    done: true,
    ...(error ? { error } : {})
  })
}

async function runBridgedProviderStream(
  streamId: string,
  providerConfig: ProviderConfig,
  messages: UnifiedMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal
): Promise<void> {
  const provider = createProvider(providerConfig)
  for await (const event of provider.sendMessage(messages, tools, providerConfig, signal)) {
    if (signal.aborted) break
    sendStreamEvent(streamId, event)
  }
}

export function attachRendererProviderBridge(): void {
  if (rendererProviderBridgeAttached) return
  rendererProviderBridgeAttached = true

  window.electron.ipcRenderer.on(
    'sidecar:provider-stream-start',
    async (_event: unknown, payload: ProviderStreamStartPayload) => {
      if (payload?.method !== 'renderer/provider-stream-start' || !payload.requestId) return

      const params = payload.params ?? {}
      const streamId = typeof params.streamId === 'string' ? params.streamId : ''
      const providerConfig = params.providerConfig
      const messages = Array.isArray(params.messages) ? params.messages : []
      const tools = Array.isArray(params.tools) ? params.tools : []

      if (!streamId || !providerConfig) {
        await window.electron.ipcRenderer.invoke('sidecar:provider-stream-response', {
          requestId: payload.requestId,
          error: 'Invalid provider stream parameters'
        })
        return
      }

      const controller = new AbortController()
      try {
        await runBridgedProviderStream(streamId, providerConfig, messages, tools, controller.signal)
        sendStreamDone(streamId)
        await window.electron.ipcRenderer.invoke('sidecar:provider-stream-response', {
          requestId: payload.requestId,
          result: { accepted: true }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendStreamDone(streamId, message)
        await window.electron.ipcRenderer.invoke('sidecar:provider-stream-response', {
          requestId: payload.requestId,
          error: message
        })
      }
    }
  )
}
