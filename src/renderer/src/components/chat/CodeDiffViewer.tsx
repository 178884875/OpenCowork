import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { MONO_FONT } from '@renderer/lib/constants'
import { useSettingsStore } from '@renderer/stores/settings-store'

export type DiffViewerLine = {
  type: 'keep' | 'add' | 'del'
  text: string
  oldNum?: number
  newNum?: number
}

export type DiffViewerChunk =
  | { type: 'lines'; lines: DiffViewerLine[] }
  | { type: 'collapsed'; count: number; lines: DiffViewerLine[] }

interface CodeDiffViewerProps {
  chunks: DiffViewerChunk[]
  defaultMode?: 'split' | 'inline'
  toolbarEnd?: React.ReactNode
}

function buildSplitRows(
  lines: DiffViewerLine[]
): Array<{ left?: DiffViewerLine; right?: DiffViewerLine }> {
  const rows: Array<{ left?: DiffViewerLine; right?: DiffViewerLine }> = []
  let deleted: DiffViewerLine[] = []
  let added: DiffViewerLine[] = []

  const flushChanges = (): void => {
    if (deleted.length === 0 && added.length === 0) return
    const rowCount = Math.max(deleted.length, added.length)
    for (let index = 0; index < rowCount; index += 1) {
      rows.push({ left: deleted[index], right: added[index] })
    }
    deleted = []
    added = []
  }

  for (const line of lines) {
    if (line.type === 'keep') {
      flushChanges()
      rows.push({ left: line, right: line })
      continue
    }

    if (line.type === 'del') {
      deleted.push(line)
    } else {
      added.push(line)
    }
  }

  flushChanges()
  return rows
}

function rowTone(line: DiffViewerLine | undefined): string {
  if (!line) return 'bg-[#111214]'
  if (line.type === 'add') return 'bg-emerald-500/8'
  if (line.type === 'del') return 'bg-red-500/8'
  return 'bg-[#111214]'
}

export function CodeDiffViewer({
  chunks,
  defaultMode = 'split',
  toolbarEnd
}: CodeDiffViewerProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const persistedViewMode = useSettingsStore((state) => state.fileDiffViewMode)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())
  const viewMode = persistedViewMode ?? defaultMode

  React.useEffect(() => {
    setExpandedChunks(new Set())
  }, [chunks, viewMode])

  const renderInlineLine = (line: DiffViewerLine, key: number): React.JSX.Element => {
    const lineNumber = line.oldNum ?? line.newNum ?? ''
    const marker = line.type === 'del' ? '-' : line.type === 'add' ? '+' : ' '

    return (
      <div
        key={key}
        className={cn(
          'grid grid-cols-[18px_56px_minmax(0,1fr)] border-b border-zinc-900/80 text-[11px] leading-5 last:border-b-0',
          rowTone(line)
        )}
      >
        <span
          className={cn(
            'flex select-none items-start justify-center px-1 py-1 font-semibold',
            line.type === 'del' && 'text-red-300',
            line.type === 'add' && 'text-emerald-300',
            line.type === 'keep' && 'text-zinc-700'
          )}
        >
          {marker}
        </span>
        <span className="select-none border-x border-zinc-800/80 px-2 py-1 text-right text-zinc-500">
          {lineNumber}
        </span>
        <span
          className={cn(
            'min-w-0 whitespace-pre-wrap break-all px-3 py-1',
            line.type === 'del' && 'text-red-100/90',
            line.type === 'add' && 'text-emerald-100/90',
            line.type === 'keep' && 'text-zinc-300/90'
          )}
        >
          {line.text || ' '}
        </span>
      </div>
    )
  }

  const renderSplitCell = (
    line: DiffViewerLine | undefined,
    side: 'left' | 'right'
  ): React.JSX.Element => {
    const isDelete = side === 'left' && line?.type === 'del'
    const isAdd = side === 'right' && line?.type === 'add'
    const lineNumber = side === 'left' ? line?.oldNum : line?.newNum

    return (
      <div
        className={cn(
          'grid min-w-0 grid-cols-[56px_minmax(0,1fr)] border-b border-zinc-900/80 last:border-b-0',
          side === 'left' && 'border-r border-zinc-800/80',
          isDelete && 'bg-red-500/8',
          isAdd && 'bg-emerald-500/8',
          !isDelete && !isAdd && 'bg-[#111214]'
        )}
      >
        <span className="select-none border-r border-zinc-800/80 px-2 py-1 text-right text-[11px] text-zinc-500">
          {lineNumber ?? ''}
        </span>
        <span
          className={cn(
            'min-w-0 whitespace-pre-wrap break-all px-3 py-1 text-[11px] leading-5',
            isDelete && 'text-red-100/90',
            isAdd && 'text-emerald-100/90',
            !isDelete && !isAdd && (line ? 'text-zinc-300/90' : 'text-transparent')
          )}
        >
          {line?.text ?? ' '}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex items-center rounded-md border border-zinc-800/80 bg-[#111214] p-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => updateSettings({ fileDiffViewMode: 'inline' })}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              viewMode === 'inline'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200'
            )}
          >
            {t('diffViewer.inline', { defaultValue: 'Inline' })}
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ fileDiffViewMode: 'split' })}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              viewMode === 'split'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200'
            )}
          >
            {t('diffViewer.sideBySide', { defaultValue: 'Split' })}
          </button>
        </div>
        {toolbarEnd ? (
          <div className="flex items-center justify-end gap-2 text-[10px] text-zinc-500">
            {toolbarEnd}
          </div>
        ) : null}
      </div>

      <div
        className="overflow-hidden rounded-lg border border-zinc-800/80 bg-[#111214] shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
        style={{ fontFamily: MONO_FONT }}
      >
        {viewMode === 'split' ? (
          <div className="max-h-80 overflow-auto">
            <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-zinc-800/80 bg-[#15171a] text-[10px] uppercase tracking-[0.14em] text-zinc-500">
              <div className="border-r border-zinc-800/80 px-3 py-2">
                {t('diffViewer.before', { defaultValue: 'Before' })}
              </div>
              <div className="px-3 py-2">{t('diffViewer.after', { defaultValue: 'After' })}</div>
            </div>
            {chunks.map((chunk, ci) => {
              if (chunk.type === 'lines' || expandedChunks.has(ci)) {
                return buildSplitRows(chunk.lines).map((row, rowIndex) => (
                  <div key={`split-${ci}-${rowIndex}`} className="grid grid-cols-2">
                    {renderSplitCell(row.left, 'left')}
                    {renderSplitCell(row.right, 'right')}
                  </div>
                ))
              }

              return (
                <button
                  key={`split-collapsed-${ci}`}
                  type="button"
                  className="flex w-full items-center justify-center border-b border-zinc-800/80 bg-[#15171a]/60 px-3 py-2 text-[10px] text-zinc-500 transition-colors hover:bg-[#1a1d21] hover:text-zinc-200"
                  onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
                >
                  {t('diffViewer.unchangedLines', {
                    count: chunk.count,
                    defaultValue: 'Show {{count}} unchanged lines'
                  })}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="max-h-80 overflow-auto">
            {chunks.map((chunk, ci) => {
              if (chunk.type === 'lines' || expandedChunks.has(ci)) {
                return chunk.lines.map((line, li) => renderInlineLine(line, ci * 1000 + li))
              }

              return (
                <button
                  key={`inline-collapsed-${ci}`}
                  type="button"
                  className="flex w-full items-center justify-center border-y border-zinc-800/80 bg-[#15171a]/60 px-3 py-2 text-[10px] text-zinc-500 transition-colors hover:bg-[#1a1d21] hover:text-zinc-200"
                  onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
                >
                  {t('diffViewer.unchangedLines', {
                    count: chunk.count,
                    defaultValue: 'Show {{count}} unchanged lines'
                  })}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
