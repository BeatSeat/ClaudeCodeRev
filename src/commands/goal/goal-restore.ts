/**
 * Official 2.1.136 G30 — /goal breakpoint-resume restore (bundle `Hb4`/`yB5`).
 *
 * When resuming/continuing a session, scan the transcript for the last
 * un-met `goal_status` attachment and re-attach the goal: re-register the Stop
 * prompt hook and set `activeGoal` in AppState, then log
 * `tengu_goal_restored_on_resume`.
 *
 * NOTE ON SCOPE: this port is the *resume-restore* path only (the 136 delta).
 * The full /goal feature base — the `/goal` command, the Stop-hook goal loop
 * that PRODUCES `goal_status` attachments, and the `activeGoal` AppState field —
 * is not present in the 2.1.136 TypeScript tree (see goal-telemetry.ts: "Full
 * /goal UI is 139"). As a result `findGoalToRestore` returns null for any
 * transcript that the 136 tree could have produced, so this path is dormant
 * until the goal base is restored, but it is wired faithfully and will become
 * live the moment a transcript carries an un-met `goal_status` attachment.
 */

import { getSessionId } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { addSessionHook } from '../../utils/hooks/sessionHooks.js'

/**
 * Official 2.1.136 — session-scoped /goal progress (AppState.activeGoal).
 * The 136 shape has no `tokensAtStart` (added in 2.1.139).
 */
export type ActiveGoal = {
  condition: string
  iterations: number
  setAt: number
  lastReason?: string
}

// AppState has no `activeGoal` field in the 136 tree; intersect so the
// restore path can read/write it without a full AppState type change (same
// approach as the 2.1.139 goal types).
export type AppStateWithGoal = AppState & { activeGoal?: ActiveGoal }

// A persisted goal_status attachment (written by the goal Stop-hook loop, which
// is part of the not-yet-restored goal base).
type GoalStatusAttachment = {
  type: 'goal_status'
  met: boolean
  condition: string
  reason?: string
}

/**
 * Official 2.1.136 `$oH` — the /goal feature gate.
 *
 * 136 gates the goal feature on the `tengu_maple_tide` GrowthBook flag
 * (default false). Upstream removed this gate in 2.1.139+ (goal was then gated
 * on non-interactive/remote session mode); kept here for 2.1.136 fidelity.
 */
export function isGoalEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE<boolean>('tengu_maple_tide', false)
}

/**
 * Official 2.1.136 `Hb4` (findGoalToRestore): scan the transcript from the end
 * for the last `goal_status` attachment and return its condition if it is not
 * yet met; otherwise null.
 */
export function findGoalToRestore(
  messages: Message[] | undefined | null,
): string | null {
  if (!messages) {
    return null
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'attachment' || message.attachment.type !== 'goal_status') {
      continue
    }
    const status = message.attachment as unknown as GoalStatusAttachment
    return status.met ? null : status.condition
  }
  return null
}

/**
 * Official 2.1.136 `yB5` (restoreGoalFromTranscript): re-attach an in-progress
 * goal on resume. If there is no goal to restore, ensure `activeGoal` is clear;
 * otherwise re-register the Stop prompt hook, set `activeGoal` fresh, and log
 * `tengu_goal_restored_on_resume`.
 */
export function restoreGoalFromTranscript(
  messages: Message[] | undefined | null,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  const condition = findGoalToRestore(messages)
  if (condition === null) {
    setAppState(prev =>
      (prev as AppStateWithGoal).activeGoal === undefined
        ? prev
        : ({ ...prev, activeGoal: undefined } as AppState),
    )
    return
  }
  // Re-register the Stop prompt hook (empty matcher) so the goal is checked at
  // each turn's end — same shape the goal loop registers when /goal is set.
  addSessionHook(setAppState, getSessionId(), 'Stop', '', {
    type: 'prompt',
    prompt: condition,
  })
  setAppState(
    prev =>
      ({
        ...prev,
        activeGoal: { condition, iterations: 0, setAt: Date.now() },
      } as AppState),
  )
  logEvent('tengu_goal_restored_on_resume', {
    promptLength: condition.length,
  })
}
