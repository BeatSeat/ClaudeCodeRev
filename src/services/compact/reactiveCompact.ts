/**
 * Official 2.1.178 reactive-compact gate.
 * Full summarize/retry body is a pre-existing stub gap — this hop lands
 * `Dzq` (`hasPrecomputedSwap`) and the `g_$` skip shared with autocompact.
 */
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isAutoCompactEnabled, isEphemeralAutocompactSkipSource } from './autoCompact.js'
import type { CompactionResult } from './compact.js'

/** Official 2.1.179 `h$H` (178 `m$H`). After remote GB check, always on. */
export function isReactiveCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    if (
      !getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_reactive_compact_remote',
        false,
      )
    ) {
      return false
    }
  }
  return true
}

export type ReactiveCompactAttempt = {
  hasAttempted: boolean
  querySource?: string
  aborted: boolean
  /** Official 2.1.178 — true when a precomputed swap is already in hand. */
  hasPrecomputedSwap?: boolean
}

/**
 * Official 2.1.178 `Dzq`.
 * `hasPrecomputedSwap===true` bypasses the ephemeral-source skip.
 */
export function shouldAttemptReactiveCompact(
  attempt: ReactiveCompactAttempt,
): boolean {
  return (
    !attempt.hasAttempted &&
    attempt.querySource !== 'compact' &&
    (attempt.hasPrecomputedSwap === true ||
      !isEphemeralAutocompactSkipSource(attempt.querySource)) &&
    isAutoCompactEnabled() &&
    isReactiveCompactEnabled() &&
    !attempt.aborted
  )
}

export async function tryReactiveCompact(args: {
  hasAttempted: boolean
  querySource?: string
  aborted: boolean
  hasPrecomputedSwap?: boolean
  messages?: unknown
  cacheSafeParams?: unknown
}): Promise<CompactionResult | null> {
  if (
    !shouldAttemptReactiveCompact({
      hasAttempted: args.hasAttempted,
      querySource: args.querySource,
      aborted: args.aborted,
      hasPrecomputedSwap: args.hasPrecomputedSwap,
    })
  ) {
    return null
  }
  // Pre-existing: official `tm8` summarize/retry is not on this tree.
  return null
}
