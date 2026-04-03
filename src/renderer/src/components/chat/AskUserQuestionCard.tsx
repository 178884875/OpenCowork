import * as React from 'react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCircle2, ChevronRight, ChevronLeft, MessageSquare } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { resolveAskUserAnswers } from '@renderer/lib/tools/ask-user-tool'
import type { AskUserQuestionItem, AskUserAnswers } from '@renderer/lib/tools/ask-user-tool'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import {
  decodeStructuredToolResult,
  isStructuredToolErrorText
} from '@renderer/lib/tools/tool-result-format'

interface AskUserQuestionCardProps {
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  isLive: boolean
}

interface AnsweredPair {
  question: string
  answer: string
}

const RECOMMENDED_OPTION_RE = /(?:\(|（)\s*(recommended|推荐)\s*(?:\)|）)/i

function isRecommendedOptionLabel(label: string): boolean {
  return RECOMMENDED_OPTION_RE.test(label)
}

function buildRecommendedAnswers(
  questions: AskUserQuestionItem[]
): { answers: AskUserAnswers; selections: Map<number, Set<string>> } | null {
  const answers: AskUserAnswers = {}
  const selections = new Map<number, Set<string>>()

  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index]
    const recommended = (item.options ?? [])
      .map((opt) => opt.label)
      .filter((label) => isRecommendedOptionLabel(label))

    if (recommended.length === 0) {
      return null
    }

    const chosen = item.multiSelect ? recommended : [recommended[0]]
    selections.set(index, new Set(chosen))
    answers[String(index)] = item.multiSelect ? chosen : chosen[0]
  }

  return { answers, selections }
}

function QuestionBlock({
  index,
  item,
  selected,
  customText,
  onToggle,
  onCustomTextChange,
  disabled
}: {
  index: number
  item: AskUserQuestionItem
  selected: Set<string>
  customText: string
  onToggle: (index: number, value: string) => void
  onCustomTextChange: (index: number, text: string) => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const isOtherSelected = selected.has('__other__')

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-semibold leading-tight text-foreground">{item.question}</p>
      {item.options && item.options.length > 0 && (
        <div className="space-y-1.5">
          {item.options.map((opt, oi) => {
            const value = opt.label
            const isSelected = selected.has(value)
            return (
              <button
                key={oi}
                disabled={disabled}
                onClick={() => onToggle(index, value)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] leading-tight transition-all',
                  isSelected
                    ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                    : 'border-border/80 bg-background/80 hover:border-primary/50 hover:bg-muted/40 hover:shadow-sm',
                  disabled && 'cursor-not-allowed opacity-50'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-all',
                    item.multiSelect ? 'rounded-md' : 'rounded-full',
                    isSelected
                      ? 'scale-105 border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40 bg-background'
                  )}
                >
                  {isSelected && <Check className="size-3 stroke-[2.5]" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'font-medium transition-colors',
                      isSelected ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {opt.label}
                  </div>
                  {opt.description && (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
                      {opt.description}
                    </p>
                  )}
                </div>
              </button>
            )
          })}
          <button
            disabled={disabled}
            onClick={() => onToggle(index, '__other__')}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] leading-tight transition-all',
              isOtherSelected
                ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                : 'border-border/80 bg-background/80 hover:border-primary/50 hover:bg-muted/40 hover:shadow-sm',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-all',
                item.multiSelect ? 'rounded-md' : 'rounded-full',
                isOtherSelected
                  ? 'scale-105 border-primary bg-primary text-primary-foreground'
                  : 'border-muted-foreground/40 bg-background'
              )}
            >
              {isOtherSelected && <Check className="size-3 stroke-[2.5]" />}
            </span>
            <span
              className={cn(
                'font-medium transition-colors',
                isOtherSelected ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {t('askUser.other', { defaultValue: '其他' })}
            </span>
          </button>
        </div>
      )}
      {(!item.options || item.options.length === 0 || isOtherSelected) && (
        <textarea
          disabled={disabled}
          value={customText}
          onChange={(e) => onCustomTextChange(index, e.target.value)}
          placeholder={t('askUser.answerPlaceholder', { defaultValue: '输入你的回答…' })}
          rows={2}
          className={cn(
            'w-full rounded-lg border bg-background/70 px-3 py-2 text-sm',
            'resize-none placeholder:text-muted-foreground/50',
            'transition-all duration-200',
            'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30',
            'hover:border-primary/50',
            disabled && 'cursor-not-allowed bg-muted/20 opacity-50'
          )}
        />
      )}
    </div>
  )
}

function outputAsText(output: ToolResultContent | undefined): string | null {
  if (!output) return null
  const text =
    typeof output === 'string'
      ? output
      : output
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
  if (!text || text.startsWith('{')) return null
  return text
}

function parseAnsweredPairs(output: ToolResultContent | undefined): AnsweredPair[] {
  const text = outputAsText(output)
  if (!text || !/^User answered:\s*/i.test(text)) return []

  const body = text.replace(/^User answered:\s*/i, '').trim()
  if (!body) return []

  const pairs: AnsweredPair[] = []
  const lines = body.split(/\r?\n/)
  let currentQuestion = ''
  let currentAnswerLines: string[] = []
  let collectingAnswer = false

  const flush = (): void => {
    const question = currentQuestion.trim()
    const answer = currentAnswerLines.join('\n').trim()
    if (question && answer) {
      pairs.push({ question, answer })
    }
    currentQuestion = ''
    currentAnswerLines = []
    collectingAnswer = false
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (collectingAnswer && currentAnswerLines.length > 0) {
        currentAnswerLines.push('')
      }
      continue
    }

    if (line.startsWith('Q: ')) {
      flush()
      currentQuestion = line.slice(3).trim()
      continue
    }

    if (line.startsWith('A: ')) {
      collectingAnswer = true
      currentAnswerLines = [line.slice(3).trim()]
      continue
    }

    if (collectingAnswer) {
      currentAnswerLines.push(line)
    } else if (currentQuestion) {
      currentQuestion = `${currentQuestion} ${line}`.trim()
    }
  }

  flush()
  return pairs
}

export function AskUserQuestionCard({
  toolUseId,
  input,
  output,
  status,
  isLive
}: AskUserQuestionCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const questions = React.useMemo(
    () => (input.questions as AskUserQuestionItem[]) ?? [],
    [input.questions]
  )
  const activeSessionMode = useChatStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.mode
  )
  const clarifyAutoAcceptRecommended = useSettingsStore((s) => s.clarifyAutoAcceptRecommended)
  const answeredPairs = React.useMemo(() => parseAnsweredPairs(output), [output])
  const answeredText = React.useMemo(() => outputAsText(output), [output])
  const outputErrorMessage = React.useMemo(() => {
    if (!output || typeof output !== 'string' || !isStructuredToolErrorText(output)) return null
    const parsed = decodeStructuredToolResult(output)
    if (!parsed || Array.isArray(parsed) || typeof parsed.error !== 'string') return null
    return parsed.error
  }, [output])
  const isError = status === 'error' || !!outputErrorMessage
  const isCanceled = status === 'canceled'
  const isAnswered = status === 'completed' && answeredPairs.length > 0
  const isPending = !isAnswered && !isError && !isCanceled && (status === 'running' || isLive)

  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map())
  const [customTexts, setCustomTexts] = useState<Map<number, string>>(() => new Map())
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const autoSubmittedRef = React.useRef(false)

  const recommendedAnswers = React.useMemo(() => buildRecommendedAnswers(questions), [questions])

  React.useEffect(() => {
    autoSubmittedRef.current = false
  }, [toolUseId])

  React.useEffect(() => {
    if (autoSubmittedRef.current) return
    if (!isPending || isAnswered) return
    if (activeSessionMode !== 'clarify') return
    if (!clarifyAutoAcceptRecommended) return
    if (!recommendedAnswers) return

    autoSubmittedRef.current = true
    setSelections(recommendedAnswers.selections)
    setCurrentQuestionIndex(Math.max(questions.length - 1, 0))
    resolveAskUserAnswers(toolUseId, recommendedAnswers.answers)
  }, [
    activeSessionMode,
    clarifyAutoAcceptRecommended,
    isAnswered,
    isPending,
    questions.length,
    recommendedAnswers,
    toolUseId
  ])

  const handleToggle = useCallback(
    (qIdx: number, value: string) => {
      setSelections((prev) => {
        const next = new Map(prev)
        const current = new Set(next.get(qIdx) ?? [])
        const q = questions[qIdx]
        if (value === '__other__') {
          if (current.has('__other__')) {
            current.delete('__other__')
          } else {
            if (!q?.multiSelect) current.clear()
            current.add('__other__')
          }
        } else if (current.has(value)) {
          current.delete(value)
        } else {
          if (!q?.multiSelect) {
            current.clear()
          }
          current.add(value)
          if (!q?.multiSelect) current.delete('__other__')
        }
        next.set(qIdx, current)
        return next
      })
    },
    [questions]
  )

  const handleCustomTextChange = useCallback((qIdx: number, text: string) => {
    setCustomTexts((prev) => {
      const next = new Map(prev)
      next.set(qIdx, text)
      return next
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const answers: AskUserAnswers = {}
    for (let i = 0; i < questions.length; i++) {
      const sel = selections.get(i) ?? new Set()
      const custom = customTexts.get(i) ?? ''
      const q = questions[i]
      const picked = [...sel].filter((value) => value !== '__other__')

      if (sel.has('__other__') || !q.options || q.options.length === 0) {
        if (custom.trim()) {
          answers[String(i)] = q.multiSelect ? [...picked, custom.trim()] : custom.trim()
        } else if (picked.length > 0) {
          answers[String(i)] = q.multiSelect ? picked : picked[0]
        }
      } else if (picked.length > 0) {
        answers[String(i)] = q.multiSelect ? picked : picked[0]
      }
    }
    resolveAskUserAnswers(toolUseId, answers)
  }, [toolUseId, questions, selections, customTexts])

  const hasCurrentAnswer = React.useMemo(() => {
    const sel = selections.get(currentQuestionIndex) ?? new Set()
    const custom = customTexts.get(currentQuestionIndex) ?? ''
    const q = questions[currentQuestionIndex]
    if (!q) return false
    if (sel.size > 0 && !sel.has('__other__')) return true
    if (sel.has('__other__') && custom.trim()) return true
    if ((!q.options || q.options.length === 0) && custom.trim()) return true
    return false
  }, [currentQuestionIndex, questions, selections, customTexts])

  const hasAllAnswers = React.useMemo(() => {
    for (let i = 0; i < questions.length; i++) {
      const sel = selections.get(i) ?? new Set()
      const custom = customTexts.get(i) ?? ''
      const q = questions[i]
      const hasAnswer =
        (sel.size > 0 && !sel.has('__other__')) ||
        (sel.has('__other__') && custom.trim()) ||
        ((!q.options || q.options.length === 0) && custom.trim())
      if (!hasAnswer) return false
    }
    return true
  }, [questions, selections, customTexts])

  const isLastQuestion = currentQuestionIndex === questions.length - 1
  const isFirstQuestion = currentQuestionIndex === 0

  const handleNext = useCallback(() => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1)
    }
  }, [currentQuestionIndex, questions.length])

  const handlePrevious = useCallback(() => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1)
    }
  }, [currentQuestionIndex])

  if (isError || isCanceled) {
    const title = isCanceled
      ? t('askUser.canceledTitle', { defaultValue: '提问已取消' })
      : t('askUser.errorTitle', { defaultValue: '提问失败' })
    const subtitle = isCanceled
      ? t('askUser.canceledSubtitle', { defaultValue: '本次提问在等待回答前已中止。' })
      : t('askUser.errorSubtitle', { defaultValue: '这次没有进入等待回答状态。' })

    return (
      <div
        className={cn(
          'my-2.5 rounded-lg p-4 shadow-sm',
          isCanceled
            ? 'border border-border/70 bg-muted/20'
            : 'border border-destructive/40 bg-destructive/5'
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-full border',
              isCanceled
                ? 'border-border/60 bg-background/70'
                : 'border-destructive/30 bg-destructive/10'
            )}
          >
            <MessageSquare
              className={cn('size-3.5', isCanceled ? 'text-muted-foreground' : 'text-destructive')}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div>{title}</div>
            <div className="text-[11px] text-muted-foreground">{subtitle}</div>
          </div>
        </div>

        {(outputErrorMessage ?? answeredText) && (
          <div
            className={cn(
              'mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap',
              isCanceled
                ? 'border-border/60 bg-background/60 text-muted-foreground'
                : 'border-destructive/30 bg-background/60 text-muted-foreground'
            )}
          >
            {outputErrorMessage ?? answeredText}
          </div>
        )}
      </div>
    )
  }

  if (isAnswered) {
    return (
      <div className="my-2.5 rounded-lg border border-border/70 bg-background/70 p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/40">
            <CheckCircle2 className="size-3.5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <div>{t('askUser.answeredTitle', { defaultValue: '问题已回答' })}</div>
            <div className="text-[11px] text-muted-foreground">
              {t('askUser.answeredSubtitle', { defaultValue: '已记录你的选择与补充说明' })}
            </div>
          </div>
        </div>

        <div className="mt-3 space-y-2.5">
          {answeredPairs.map((pair, index) => (
            <div
              key={`${pair.question}-${index}`}
              className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
            >
              <div className="flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Q
                </span>
                <span className="text-foreground/90">{pair.question}</span>
              </div>
              <div className="mt-1.5 flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  A
                </span>
                <span className="whitespace-pre-wrap break-words text-muted-foreground">
                  {pair.answer}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const currentQuestion = questions[currentQuestionIndex]
  if (!currentQuestion) return <></>

  return (
    <div className="my-2.5 rounded-lg border border-border/70 bg-background/70 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/40">
          <MessageSquare className="size-3.5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {t('askUser.title', { defaultValue: '需要你的回答' })}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t('askUser.subtitle', { defaultValue: '回答这些问题后，我再继续处理。' })}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
          {questions.length > 1 && (
            <span className="font-mono text-xs">
              {currentQuestionIndex + 1}/{questions.length}
            </span>
          )}
          {isPending && (
            <span className="flex items-center gap-1 text-primary/80">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              {t('askUser.waiting', { defaultValue: '等待回答' })}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3">
        <QuestionBlock
          index={currentQuestionIndex}
          item={currentQuestion}
          selected={selections.get(currentQuestionIndex) ?? new Set()}
          customText={customTexts.get(currentQuestionIndex) ?? ''}
          onToggle={handleToggle}
          onCustomTextChange={handleCustomTextChange}
          disabled={!isPending}
        />
      </div>

      {isPending && (
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3">
          {questions.length > 1 && !isFirstQuestion && (
            <Button
              onClick={handlePrevious}
              variant="outline"
              size="xs"
              className="gap-1 text-[12px]"
            >
              <ChevronLeft className="size-3.5" />
              {t('askUser.previous', { defaultValue: '上一步' })}
            </Button>
          )}

          <div className="flex-1" />

          {questions.length > 1 && !isLastQuestion && (
            <Button
              onClick={handleNext}
              disabled={!hasCurrentAnswer}
              size="xs"
              className="gap-1 text-[12px]"
            >
              {t('askUser.next', { defaultValue: '下一步' })}
              <ChevronRight className="size-3.5" />
            </Button>
          )}

          {isLastQuestion && (
            <Button
              onClick={handleSubmit}
              disabled={!hasAllAnswers}
              size="xs"
              className="gap-1 text-[12px]"
            >
              {t('askUser.submit', { defaultValue: '提交' })}
              <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
