import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Brain, icons } from 'lucide-react'

import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import type { ToolResultContent } from '@renderer/lib/api/types'

interface SubAgentCardProps {
  name: string
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
  isLive?: boolean
}

function getSubAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Brain className="size-4" />
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function formatOrderLabel(toolUseId: string): string {
  const digitSuffix = toolUseId.match(/\d+$/)?.[0]
  if (digitSuffix) return digitSuffix.slice(-2).padStart(2, '0')
  return toolUseId.slice(-2).toUpperCase().padStart(2, '0')
}

function DotMatrix({
  filled,
  tone
}: {
  filled: number
  tone: 'active' | 'complete' | 'failed' | 'idle'
}): React.JSX.Element {
  const total = 24
  const clampedFilled = Math.max(0, Math.min(total, filled))

  return (
    <div
      className="grid gap-[2px]"
      style={{ gridTemplateColumns: 'repeat(12, 3px)' }}
      aria-hidden="true"
    >
      {Array.from({ length: total }).map((_, index) => {
        const isFilled = index < clampedFilled
        return (
          <span
            key={index}
            className={cn(
              'block size-[3px] rounded-[1px] transition-colors',
              !isFilled && 'bg-white/[0.08]',
              isFilled &&
                tone === 'failed' &&
                'bg-destructive/80 shadow-[0_0_5px_rgba(248,113,113,0.35)]',
              isFilled &&
                tone !== 'failed' &&
                'bg-[#8cff72] shadow-[0_0_5px_rgba(140,255,114,0.45)]'
            )}
          />
        )
      })}
    </div>
  )
}

function SubAgentCardInner({
  name,
  toolUseId,
  input,
  output,
  isLive = false
}: SubAgentCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  void isLive

  const displayName = String(input.subagent_type ?? name)
  const tracked = useAgentStore(
    useShallow((s) => {
      const item =
        s.activeSubAgents[toolUseId] ??
        s.completedSubAgents[toolUseId] ??
        s.subAgentHistory.find((entry) => entry.toolUseId === toolUseId) ??
        null

      if (!item) return null

      return {
        isRunning: item.isRunning,
        success: item.success,
        errorMessage: item.errorMessage,
        iteration: item.iteration,
        toolCallCount: item.toolCalls.length,
        usage: item.usage ?? null,
        startedAt: item.startedAt,
        completedAt: item.completedAt
      }
    })
  )

  const outputStr = typeof output === 'string' ? output : undefined
  const parsed = React.useMemo(() => {
    if (!outputStr) return { meta: null, text: '' }
    return parseSubAgentMeta(outputStr)
  }, [outputStr])

  const histMeta = parsed.meta
  const histText = parsed.text || outputStr || ''
  const usage = tracked?.usage ?? histMeta?.usage ?? null
  const isRunning = tracked?.isRunning ?? false
  const isCompleted = !isRunning && (!!output || !!tracked)
  const historicalError = outputStr
    ? (() => {
        const parsedOutput = decodeStructuredToolResult(outputStr)
        if (
          parsedOutput &&
          !Array.isArray(parsedOutput) &&
          typeof parsedOutput.error === 'string'
        ) {
          return true
        }

        const parsedHistText = decodeStructuredToolResult(histText)
        return !!(
          parsedHistText &&
          !Array.isArray(parsedHistText) &&
          typeof parsedHistText.error === 'string'
        )
      })()
    : false
  const isError = tracked?.success === false || !!tracked?.errorMessage || historicalError

  const [now, setNow] = React.useState(tracked?.startedAt ?? 0)
  React.useEffect(() => {
    if (!tracked?.isRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [tracked?.isRunning, tracked?.startedAt])

  const elapsed = tracked
    ? (tracked.completedAt ?? (tracked.isRunning ? now : tracked.startedAt)) - tracked.startedAt
    : histMeta?.elapsed

  const descriptionText = input.description ? String(input.description) : ''
  const promptText = [
    input.prompt ? String(input.prompt) : '',
    input.query ? String(input.query) : '',
    input.task ? String(input.task) : '',
    input.target ? String(input.target) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const iterationCount = tracked?.iteration ?? histMeta?.iterations ?? 0
  const callCount = tracked?.toolCallCount ?? histMeta?.toolCalls.length ?? 0
  const totalTokens = usage ? formatTokens(getBillableTotalTokens(usage)) : null
  const statusText = isRunning
    ? t('subAgent.working')
    : isError
      ? t('subAgent.failed')
      : t('subAgent.done')
  const previewText = descriptionText || promptText || statusText
  const orderLabel = formatOrderLabel(toolUseId)
  const icon = getSubAgentIcon(displayName)
  const meterFill = isError
    ? 18
    : isRunning
      ? Math.max(8, Math.min(22, (callCount || iterationCount || 8) + 8))
      : isCompleted
        ? 24
        : 6
  const meterTone = isError ? 'failed' : isRunning ? 'active' : isCompleted ? 'complete' : 'idle'
  const metaText = [
    statusText,
    elapsed != null ? formatElapsed(elapsed) : '',
    iterationCount > 0 ? t('subAgent.iter', { count: iterationCount }) : '',
    callCount > 0 ? t('subAgent.calls', { count: callCount }) : '',
    totalTokens ? `${totalTokens} tok` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const handleOpenPanel = (): void => {
    useUIStore.getState().openSubAgentExecutionDetail(toolUseId, histText || undefined)
  }

  return (
    <button
      type="button"
      onClick={handleOpenPanel}
      title={`${t('subAgent.viewDetails')} · ${metaText}`}
      className={cn(
        'group my-2 w-full overflow-hidden rounded-[9px] px-3 py-2.5 text-left transition-colors',
        'border border-white/[0.06] bg-[#1f1f1f] hover:border-white/[0.1] hover:bg-[#242424]',
        isRunning && 'border-emerald-400/20',
        isError && 'border-destructive/25 bg-[#241919] hover:bg-[#2a1c1c]'
      )}
    >
      <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        <div
          className={cn(
            'row-span-2 flex size-7 items-center justify-center overflow-hidden rounded-full border text-white/90',
            isRunning ? 'border-emerald-400/35 bg-emerald-400/10' : 'border-white/10 bg-[#141414]',
            isError && 'border-destructive/35 bg-destructive/10 text-destructive'
          )}
        >
          {icon}
        </div>

        <div className="min-w-0 self-center">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-white/82">{displayName}</span>
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                isError && 'bg-destructive/80',
                isRunning && 'bg-[#8cff72] shadow-[0_0_6px_rgba(140,255,114,0.55)]',
                !isError && !isRunning && isCompleted && 'bg-white/38',
                !isError && !isRunning && !isCompleted && 'bg-white/20'
              )}
            />
          </div>
        </div>

        <span className="self-center pl-3 text-[12px] font-semibold tabular-nums tracking-wide text-white/72">
          {orderLabel}
        </span>

        <div className="min-w-0 self-end">
          <div className="flex min-w-0 items-center gap-2">
            <span className="-mt-1 h-4 w-3 shrink-0 rounded-bl-[5px] border-b border-l border-white/[0.14]" />
            <p className="truncate text-[12px] leading-5 text-white/55">{previewText}</p>
          </div>
        </div>

        <div className="self-end pb-1 pl-3">
          <DotMatrix filled={meterFill} tone={meterTone} />
        </div>
      </div>
    </button>
  )
}

export const SubAgentCard = React.memo(SubAgentCardInner)
