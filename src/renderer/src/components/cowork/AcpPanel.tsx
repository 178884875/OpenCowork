import {
  ShieldCheck,
  ArrowRightLeft,
  FileWarning,
  GitBranchPlus,
  ClipboardList,
  ListChecks,
  GaugeCircle
} from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useTaskStore } from '@renderer/stores/task-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'

export function AcpPanel(): React.JSX.Element {
  const { t } = useTranslation(['layout', 'cowork'])
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const planMode = useUIStore((s) => s.planMode)
  const plan = usePlanStore((s) => {
    if (!activeSessionId) return undefined
    return Object.values(s.plans).find((item) => item.sessionId === activeSessionId)
  })
  // NOTE: select the raw tasks array (stable reference) and filter with useMemo.
  // Returning a freshly-computed array from the selector breaks
  // useSyncExternalStore's snapshot equality and causes an infinite render loop.
  const allTasks = useTaskStore((s) => s.tasks)
  const tasks = useMemo(
    () => (activeSessionId ? allTasks.filter((task) => task.sessionId === activeSessionId) : []),
    [allTasks, activeSessionId]
  )

  const progress = useMemo(() => {
    const total = tasks.length
    const completed = tasks.filter((task) => task.status === 'completed').length
    const inProgress = tasks.filter((task) => task.status === 'in_progress').length
    return { total, completed, inProgress }
  }, [tasks])

  const phaseLabel = planMode
    ? t('rightPanel.acpPhasePlan', { ns: 'layout', defaultValue: '规划中' })
    : plan?.status === 'implementing'
      ? t('rightPanel.acpPhaseExecute', { ns: 'layout', defaultValue: '分派执行' })
      : plan?.status === 'approved'
        ? t('rightPanel.acpPhaseApproved', { ns: 'layout', defaultValue: '待执行' })
        : plan
          ? t('rightPanel.acpPhaseReview', { ns: 'layout', defaultValue: '方案评审' })
          : t('rightPanel.acpPhaseClarify', { ns: 'layout', defaultValue: '需求澄清' })

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-xl border bg-background/60 p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">{t('rightPanel.acpTitle', { ns: 'layout' })}</h3>
          <Badge variant="secondary">ACP</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('rightPanel.acpDesc', { ns: 'layout' })}</p>

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <GaugeCircle className="size-3.5" />
              {t('rightPanel.acpCurrentPhase', { ns: 'layout', defaultValue: '当前阶段' })}
            </div>
            <p className="mt-2 text-sm font-medium">{phaseLabel}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ClipboardList className="size-3.5" />
              {t('rightPanel.plan', { ns: 'layout' })}
            </div>
            <p className="mt-2 line-clamp-2 text-sm font-medium">
              {plan?.title ?? t('plan.noPlan', { ns: 'cowork' })}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ListChecks className="size-3.5" />
              {t('rightPanel.steps', { ns: 'layout' })}
            </div>
            <p className="mt-2 text-sm font-medium">
              {progress.completed}/{progress.total}
              {progress.inProgress > 0
                ? ` · ${t('rightPanel.acpInProgressCount', {
                    ns: 'layout',
                    count: progress.inProgress,
                    defaultValue: `${progress.inProgress} 进行中`
                  })}`
                : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border bg-background/60 p-4 text-sm text-muted-foreground">
        <div className="flex items-start gap-2">
          <FileWarning className="mt-0.5 size-4 text-amber-500" />
          <p>{t('rightPanel.acpRuleNoCode', { ns: 'layout' })}</p>
        </div>
        <div className="flex items-start gap-2">
          <GitBranchPlus className="mt-0.5 size-4 text-cyan-500" />
          <p>{t('rightPanel.acpRuleDelegate', { ns: 'layout' })}</p>
        </div>
        <div className="flex items-start gap-2">
          <ArrowRightLeft className="mt-0.5 size-4 text-emerald-500" />
          <p>{t('rightPanel.acpRuleReport', { ns: 'layout' })}</p>
        </div>
      </div>

      <div className="rounded-xl border bg-background/60 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('rightPanel.acpNextAction', { ns: 'layout', defaultValue: '建议下一步' })}
        </p>
        <Separator className="my-3" />
        <p className="text-sm text-muted-foreground">
          {planMode
            ? t('rightPanel.acpNextActionPlan', {
                ns: 'layout',
                defaultValue: '继续完善实施计划，保存后退出 Plan Mode。'
              })
            : plan?.status === 'approved' || plan?.status === 'implementing'
              ? t('rightPanel.acpNextActionExecute', {
                  ns: 'layout',
                  defaultValue: '继续把已批准计划拆成任务，分派子代理执行，并汇总结果。'
                })
              : t('rightPanel.acpNextActionClarify', {
                  ns: 'layout',
                  defaultValue: '先补齐目标、约束、边界与验收标准，再进入计划。'
                })}
        </p>
      </div>
    </div>
  )
}
