import type { AgentEvent } from '@renderer/lib/agent/types'
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
import {
  normalizeSidecarAgentEvent,
  normalizeSidecarRecord,
  normalizeSidecarSubAgentEvent,
  type SidecarAgentRunRequest
} from '@renderer/lib/ipc/sidecar-protocol'
import { subAgentEvents } from '@renderer/lib/agent/sub-agents/events'

export interface RunAgentViaSidecarOptions {
  signal?: AbortSignal
  onRunIdAssigned?: (runId: string) => void
  /** When false, sub_agent_* events are pushed into the main queue instead of
   *  being routed to subAgentEvents.emit. Defaults to true (route to bus). */
  routeSubAgentEventsToBus?: boolean
}

/**
 * Runs an agent loop entirely inside the .NET sidecar and surfaces its events
 * as an AsyncIterable<AgentEvent>, matching the JS runAgentLoop contract so
 * existing consumers don't need to change their event handling.
 *
 * Tools, providers, plan/chat mode, plugin/SSH context — everything is passed
 * through the sidecar request. Unknown tools are auto-bridged back to the
 * renderer by the sidecar's ToolRegistry fallback; non-native providers are
 * flagged mode=bridged by the request builder and stream through
 * renderer-provider-bridge.
 */
export function runAgentViaSidecar(
  request: SidecarAgentRunRequest,
  options: RunAgentViaSidecarOptions = {}
): AsyncIterable<AgentEvent> {
  const { signal, onRunIdAssigned, routeSubAgentEventsToBus = true } = options
  return {
    async *[Symbol.asyncIterator]() {
      const initialized = await agentBridge.initialize()
      if (!initialized) {
        throw new Error('Sidecar unavailable')
      }

      const queue: AgentEvent[] = []
      const pendingEvents: Array<{ runId: string; rawEvent: unknown }> = []
      let finished = false
      let notify: (() => void) | null = null
      let runId = ''
      let abortCleanup: (() => void) | null = null

      const wake = (): void => {
        if (notify) {
          const resume = notify
          notify = null
          resume()
        }
      }

      const pushEvent = (normalized: AgentEvent): void => {
        queue.push(normalized)
        if (normalized.type === 'loop_end' || normalized.type === 'error') {
          finished = true
        }
        wake()
      }

      const dispatchSidecarEvent = (rawEvent: unknown): void => {
        const subAgentEvent = normalizeSidecarSubAgentEvent(rawEvent)
        if (subAgentEvent) {
          if (routeSubAgentEventsToBus) {
            subAgentEvents.emit(subAgentEvent)
            return
          }
        }

        const normalized = normalizeSidecarAgentEvent(rawEvent)
        if (normalized) {
          pushEvent(normalized)
        }
      }

      const unsub = agentBridge.on('agent/event', (payload) => {
        const record = normalizeSidecarRecord(payload)
        const eventRunId = String(record.runId ?? '')
        if (!eventRunId) return

        if (!runId) {
          pendingEvents.push({ runId: eventRunId, rawEvent: record.event })
          return
        }

        if (eventRunId !== runId) return
        dispatchSidecarEvent(record.event)
      })

      try {
        const result = await agentBridge.runAgent(request)
        runId = result.runId
        onRunIdAssigned?.(runId)

        if (signal) {
          if (signal.aborted) {
            void agentBridge.cancelAgent(runId).catch(() => {})
          } else {
            const onAbort = (): void => {
              void agentBridge.cancelAgent(runId).catch(() => {})
            }
            signal.addEventListener('abort', onAbort, { once: true })
            abortCleanup = () => signal.removeEventListener('abort', onAbort)
          }
        }

        for (const pending of pendingEvents.splice(0, pendingEvents.length)) {
          if (pending.runId !== runId) continue
          dispatchSidecarEvent(pending.rawEvent)
          if (finished) break
        }

        while (!finished || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve
            })
            continue
          }
          const next = queue.shift()
          if (next) yield next
        }
      } finally {
        abortCleanup?.()
        unsub()
      }
    }
  }
}
