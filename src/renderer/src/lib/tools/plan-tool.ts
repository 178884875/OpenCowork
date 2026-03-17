import { toolRegistry } from '../agent/tool-registry'
import { usePlanStore } from '../../stores/plan-store'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler, ToolContext } from './tool-types'

// ── Helpers ──

function getSessionId(ctx: ToolContext): string | null {
  return ctx.sessionId ?? useChatStore.getState().activeSessionId ?? null
}

function inferTitleFromContent(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'Plan'
  const first = lines[0]
    .replace(/^#+\s*/, '')
    .replace(/^plan:\s*/i, '')
    .trim()
  return first.slice(0, 80) || 'Plan'
}

// ── EnterPlanMode ──

const enterPlanModeHandler: ToolHandler = {
  definition: {
    name: 'EnterPlanMode',
    description:
      'Enter Plan Mode to explore the codebase and create a detailed implementation plan before writing any code. ' +
      'Use this proactively when starting non-trivial tasks that require architectural decisions, multi-file changes, ' +
      'or when multiple valid approaches exist. In plan mode, only read/search and plan tools are allowed — ' +
      'no Edit/Shell commands.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Brief reason in English for entering plan mode. This becomes the plan title if no plan exists (e.g. "add-user-authentication").'
        }
      }
    }
  },
  execute: async (input, ctx) => {
    const uiStore = useUIStore.getState()
    const sessionId = getSessionId(ctx)
    const session = sessionId
      ? useChatStore.getState().sessions.find((item) => item.id === sessionId)
      : undefined
    if (!session) return encodeToolError('No active session.')

    // Check if session already has a plan
    const existingPlan = usePlanStore.getState().getPlanBySession(session.id)
    if (
      existingPlan &&
      (existingPlan.status === 'drafting' || existingPlan.status === 'rejected')
    ) {
      if (!uiStore.isPlanModeEnabled(session.id)) uiStore.enterPlanMode(session.id)
      if (useChatStore.getState().activeSessionId === session.id) {
        usePlanStore.getState().setActivePlan(existingPlan.id)
      }
      return encodeStructuredToolResult({
        status: 'resumed',
        plan_id: existingPlan.id,
        message: 'Resumed existing plan draft. Draft the plan in chat, then call SavePlan.'
      })
    }

    // Create new plan record
    const reason = input.reason ? String(input.reason) : 'Implementation planning'
    const plan = usePlanStore.getState().createPlan(session.id, reason)

    if (!uiStore.isPlanModeEnabled(session.id)) uiStore.enterPlanMode(session.id)
    if (useChatStore.getState().activeSessionId === session.id) {
      uiStore.setRightPanelTab('plan')
      uiStore.setRightPanelOpen(true)
    }

    return encodeStructuredToolResult({
      status: 'entered',
      plan_id: plan.id,
      message:
        'Plan mode activated. Draft the plan in chat, then call SavePlan. Call ExitPlanMode when complete.'
    })
  },
  requiresApproval: () => false
}

// ── ExitPlanMode ──

const exitPlanModeHandler: ToolHandler = {
  definition: {
    name: 'ExitPlanMode',
    description:
      'Exit Plan Mode after completing the plan. This signals that the plan is finalized and ready for user review. ' +
      'The user can then click "Implement" in the Plan panel or reply to start implementation. ' +
      'IMPORTANT: Ensure you have called SavePlan before calling this tool. ' +
      'After calling this tool, you MUST STOP and wait for the user to review the plan — do NOT continue with any further actions.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_input, ctx) => {
    const uiStore = useUIStore.getState()
    const sessionId = getSessionId(ctx)

    if (!uiStore.isPlanModeEnabled(sessionId)) {
      return encodeStructuredToolResult({
        status: 'not_in_plan_mode',
        message: 'You are not currently in plan mode.'
      })
    }

    // Exit plan mode UI
    uiStore.exitPlanMode(sessionId)

    return encodeStructuredToolResult({
      status: 'exited',
      message:
        'Plan mode exited. STOP HERE — wait for the user to review and approve the plan in the panel.'
    })
  },
  requiresApproval: () => false
}

// ── SavePlan ──

const savePlanHandler: ToolHandler = {
  definition: {
    name: 'SavePlan',
    description:
      'Save the current plan content for the Plan panel. ' +
      'Use this after writing the plan in chat. The full plan content will be displayed to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Optional plan title. If omitted, the title is inferred from the plan content.'
        },
        content: {
          type: 'string',
          description:
            'Full plan content as written in the chat response. This will be displayed in the Plan panel.'
        }
      },
      required: ['content']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = getSessionId(ctx)
    if (!sessionId) {
      return encodeToolError('No active session.')
    }

    const content = input.content ? String(input.content) : ''
    if (!content.trim()) {
      return encodeToolError('Plan content is empty.')
    }

    const title = input.title ? String(input.title) : inferTitleFromContent(content)

    const planStore = usePlanStore.getState()
    let plan = planStore.getPlanBySession(sessionId)
    if (!plan) {
      plan = planStore.createPlan(sessionId, title, { content, status: 'drafting' })
    } else {
      planStore.updatePlan(plan.id, { title, content, status: 'drafting' })
    }
    if (useChatStore.getState().activeSessionId === sessionId) {
      planStore.setActivePlan(plan.id)
    }

    return encodeStructuredToolResult({
      status: 'saved',
      plan_id: plan.id,
      title
    })
  },
  requiresApproval: () => false
}

// ── Registration ──

export function registerPlanTools(): void {
  toolRegistry.register(enterPlanModeHandler)
  toolRegistry.register(savePlanHandler)
  toolRegistry.register(exitPlanModeHandler)
}

// ── Plan Mode Tool Filter ──

/** Tool names allowed in plan mode (read-only + planning tools) */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  // Read-only filesystem
  'Read',
  'LS',
  'Glob',
  'Grep',
  // Planning tools
  'EnterPlanMode',
  'SavePlan',
  'ExitPlanMode',
  'AskUserQuestion',
  // Task tracking
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  // SubAgent (read-only explorers)
  'Task',
  // Preview (read-only)
  'OpenPreview'
])
