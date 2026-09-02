import { randomUUID } from 'crypto'
import {
  getIsNonInteractiveSession,
  getSessionId,
  getTotalOutputTokens,
} from '../../bootstrap/state.js'
import type { PromptHook } from '../../schemas/hooks.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { shouldDisableAllHooksIncludingManaged } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  addSessionHook,
  getSessionHooks,
  removeSessionHook,
} from '../../utils/hooks/sessionHooks.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import type { ActiveGoal, AppStateWithGoal } from './types.js'

/** Official 2.1.139 OoH */
export const GOAL_CONDITION_MAX_CHARS = 4000

/** Official 2.1.139 bW5 */
const CLEAR_ALIASES = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

/** Official 2.1.139 xW5 */
export const GOAL_TRUST_GATE_MESSAGE =
  '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.'

/** Official 2.1.139 uW5 */
export const GOAL_POLICY_GATE_MESSAGE =
  "/goal is disabled by your organization's policy (disableAllHooks)."

type GoalContext = Pick<LocalJSXCommandContext, 'getAppState' | 'setAppState'> & {
  setMessages?: LocalJSXCommandContext['setMessages']
  applyMessageOp?: (op: { type: 'append'; messages: Message[] }) => void
  sessionHooksRegistry?: {
    add: (
      sessionId: string,
      event: 'Stop',
      matcher: string,
      hook: { type: 'prompt'; prompt: string },
    ) => void
    remove: (
      sessionId: string,
      event: 'Stop',
      hook: { type: 'prompt'; prompt: string },
    ) => void
  }
}

function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name:
      featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code:
      errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', {
    feature_name:
      featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export function logGoalSetSad(errorCode: string): void {
  featureSad('goal_set', errorCode)
}

/** Official 2.1.139 Cj8 */
export function isGoalClearAlias(args: string): boolean {
  return CLEAR_ALIASES.has(args.toLowerCase())
}

/** Official 2.1.139 PD4 */
export function formatLastCheck(reason: string): string {
  return `Last check: ${firstLineOf(reason.trim())}`
}

export function getActiveGoal(state: AppState): ActiveGoal | undefined {
  return (state as AppStateWithGoal).activeGoal
}

export function writeActiveGoal(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  goal: ActiveGoal | undefined,
): void {
  setAppState(prev => {
    const current = getActiveGoal(prev)
    if (goal === undefined) {
      if (current === undefined) return prev
      return { ...prev, activeGoal: undefined } as AppState
    }
    return { ...prev, activeGoal: goal } as AppState
  })
}

/** Official 2.1.139 xj8 — session Stop prompt hooks with empty matcher. */
export function getSessionGoalPromptHooks(
  appState: AppState,
  sessionId: string,
): PromptHook[] {
  const hooks: PromptHook[] = []
  for (const matcher of getSessionHooks(appState, sessionId, 'Stop').get(
    'Stop',
  ) ?? []) {
    if (matcher.matcher !== '' || matcher.skillRoot !== undefined) continue
    for (const hook of matcher.hooks) {
      if (hook.type === 'prompt') hooks.push(hook)
    }
  }
  return hooks
}

/** Official 2.1.139 Lu6 */
export function getGoalGate(): { message: string; code: string } | null {
  if (shouldDisableAllHooksIncludingManaged()) {
    return { message: GOAL_POLICY_GATE_MESSAGE, code: 'policy_gate' }
  }
  if (!getIsNonInteractiveSession() && !checkHasTrustDialogAccepted()) {
    return { message: GOAL_TRUST_GATE_MESSAGE, code: 'trust_gate' }
  }
  return null
}

/** Official 2.1.139 WD4 */
export function createGoalStatusAttachment(
  met: boolean,
  condition: string,
  extras?: {
    sentinel?: boolean
    reason?: string
    iterations?: number
    durationMs?: number
    tokens?: number
  },
): Message {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'goal_status',
      met,
      sentinel: extras?.sentinel ?? true,
      condition,
      ...(extras?.reason !== undefined ? { reason: extras.reason } : {}),
      ...(extras?.iterations !== undefined
        ? { iterations: extras.iterations }
        : {}),
      ...(extras?.durationMs !== undefined
        ? { durationMs: extras.durationMs }
        : {}),
      ...(extras?.tokens !== undefined ? { tokens: extras.tokens } : {}),
    },
  }
}

function appendMessages(context: GoalContext, messages: Message[]): void {
  if (typeof context.applyMessageOp === 'function') {
    context.applyMessageOp({ type: 'append', messages })
    return
  }
  if (typeof context.setMessages === 'function') {
    context.setMessages(prev => [...prev, ...messages])
  }
}

function addStopPromptHook(
  context: GoalContext,
  sessionId: string,
  prompt: string,
): void {
  const hook = { type: 'prompt' as const, prompt }
  if (context.sessionHooksRegistry) {
    context.sessionHooksRegistry.add(sessionId, 'Stop', '', hook)
    return
  }
  addSessionHook(context.setAppState, sessionId, 'Stop', '', hook)
}

function removeStopPromptHook(
  context: GoalContext,
  sessionId: string,
  hook: PromptHook,
): void {
  if (context.sessionHooksRegistry) {
    context.sessionHooksRegistry.remove(sessionId, 'Stop', hook)
    return
  }
  removeSessionHook(context.setAppState, sessionId, 'Stop', hook)
}

/** Official 2.1.139 bj8 */
export function buildGoalMetaPrompt(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it \u2014 treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met \u2014 do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`
}

/** Official 2.1.139 LD4 — last met non-sentinel goal_status. */
export function findLastAchievedGoal(messages: Message[]): {
  condition: string
  iterations?: number
  durationMs?: number
  tokens?: number
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'attachment') continue
    const attachment = message.attachment
    if (attachment.type !== 'goal_status') continue
    if (!attachment.met || attachment.sentinel) continue
    return {
      condition: String(attachment.condition ?? ''),
      iterations:
        typeof attachment.iterations === 'number'
          ? attachment.iterations
          : undefined,
      durationMs:
        typeof attachment.durationMs === 'number'
          ? attachment.durationMs
          : undefined,
      tokens:
        typeof attachment.tokens === 'number' ? attachment.tokens : undefined,
    }
  }
  return null
}

/**
 * Official 2.1.139 MoH — set the session Stop prompt hook + activeGoal.
 * Returns an error string, or null on success.
 */
export function setGoal(condition: string, context: GoalContext): string | null {
  const gate = getGoalGate()
  if (gate !== null) {
    featureSad('goal_set', gate.code)
    return gate.message
  }
  const sessionId = getSessionId()
  for (const hook of getSessionGoalPromptHooks(
    context.getAppState(),
    sessionId,
  )) {
    removeStopPromptHook(context, sessionId, hook)
  }
  addStopPromptHook(context, sessionId, condition)
  const activeGoal: ActiveGoal = {
    condition,
    iterations: 0,
    setAt: Date.now(),
    tokensAtStart: getTotalOutputTokens(),
  }
  writeActiveGoal(context.setAppState, activeGoal)
  appendMessages(context, [createGoalStatusAttachment(false, condition)])
  logEvent('tengu_stop_hook_added', {
    promptLength: condition.length,
    via: 'goal' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  featureOk('goal_set')
  return null
}

/**
 * Official 2.1.139 woH — clear the session goal Stop hook.
 * Returns the previous condition, or null if none was set.
 */
export function clearGoal(context: GoalContext): string | null {
  const sessionId = getSessionId()
  const hooks = getSessionGoalPromptHooks(context.getAppState(), sessionId)
  if (hooks.length === 0) return null
  const condition = hooks[0]!.prompt
  for (const hook of hooks) {
    removeStopPromptHook(context, sessionId, hook)
  }
  writeActiveGoal(context.setAppState, undefined)
  appendMessages(context, [createGoalStatusAttachment(true, condition)])
  logEvent('tengu_stop_hook_removed', {
    via: 'goal' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return condition
}

/** Official 2.1.139 — Stop hook succeeded: auto-clear matching goal. */
export function applyGoalHookSucceeded(
  context: GoalContext,
  attachment: {
    hookEvent?: unknown
    type?: unknown
    command?: unknown
  },
): Message | null {
  if (attachment.hookEvent !== 'Stop' || attachment.type !== 'hook_success') {
    return null
  }
  const goal = getActiveGoal(context.getAppState())
  if (!goal) return null
  const hooks = getSessionGoalPromptHooks(context.getAppState(), getSessionId())
  const match = hooks.find(hook => hook.prompt === goal.condition)
  if (!match) return null
  if (
    typeof attachment.command === 'string' &&
    attachment.command &&
    attachment.command !== goal.condition
  ) {
    return null
  }
  removeStopPromptHook(context, getSessionId(), match)
  const iterations = goal.iterations + 1
  const durationMs = Date.now() - goal.setAt
  const tokens = getTotalOutputTokens() - goal.tokensAtStart
  writeActiveGoal(context.setAppState, undefined)
  logEvent('tengu_goal_achieved', {
    promptLength: match.prompt.length,
    iterations,
    durationMs,
    tokens,
  })
  featureOk('goal_met')
  return createGoalStatusAttachment(true, match.prompt, {
    sentinel: false,
    iterations,
    durationMs,
    tokens,
  })
}

/** Official 2.1.139 — Stop hook blocked: bump iterations + emit not-met. */
export function applyGoalHookBlocked(
  context: GoalContext,
  blockingCommand: string | undefined,
  stopReason: string | undefined,
): Message | null {
  const goal = getActiveGoal(context.getAppState())
  if (!goal) return null
  if (blockingCommand && blockingCommand !== goal.condition) return null
  const next: ActiveGoal = {
    ...goal,
    iterations: goal.iterations + 1,
    lastReason: stopReason,
  }
  writeActiveGoal(context.setAppState, next)
  return createGoalStatusAttachment(false, goal.condition, {
    sentinel: false,
    reason: stopReason,
  })
}
