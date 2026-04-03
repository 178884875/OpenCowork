import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import type { ToolContext } from '@renderer/lib/tools/tool-types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

const RENDERER_BRIDGED_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'LS',
  'Glob',
  'Grep',
  'Bash',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'AskUserQuestion',
  'EnterPlanMode',
  'SavePlan',
  'ExitPlanMode',
  'OpenPreview',
  'Notify',
  'CronAdd',
  'CronUpdate',
  'CronRemove',
  'CronList',
  'Task',
  'Skill'
])

let rendererToolBridgeAttached = false

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function toToolContext(record: Record<string, unknown>): ToolContext {
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    workingFolder: typeof record.workingFolder === 'string' ? record.workingFolder : undefined,
    currentToolUseId: typeof record.currentToolUseId === 'string' ? record.currentToolUseId : undefined,
    agentRunId: typeof record.agentRunId === 'string' ? record.agentRunId : undefined,
    signal: new AbortController().signal,
    ipc: ipcClient
  }
}

function normalizeResultContent(content: unknown): unknown {
  return content === undefined ? '' : content
}

export function getRendererBridgedToolNames(): string[] {
  return [...RENDERER_BRIDGED_TOOL_NAMES]
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

        if (!RENDERER_BRIDGED_TOOL_NAMES.has(toolName)) {
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            error: `Renderer bridge does not support tool: ${toolName}`
          })
          return
        }

        const handler = toolRegistry.get(toolName)
        if (!handler) {
          await window.electron.ipcRenderer.invoke('sidecar:renderer-tool-response', {
            requestId: payload.requestId,
            error: `Tool handler not registered: ${toolName}`
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
