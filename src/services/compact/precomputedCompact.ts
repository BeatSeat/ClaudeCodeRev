/**
 * Precomputed-compact / PTL-borrow / swap subsystem — **2.1.144 final state**.
 *
 * This file merges the 2.1.132 subsystem MAIN BODY (already landed in-tree)
 * with the 2.1.144 consume-path EVOLUTION, so it represents what the official
 * `precomputedCompact` module looked like at 144. The 132 body is preserved
 * verbatim (all 132 exports, the `Fc`/`db` per-agent cache, the `Hw8`/`Se$`
 * key helper, the `startPrecomputedCompact` schedule, the `U45`-equivalent
 * settle, the slice/discard helpers); the 144 increment is folded in directly
 * against that same cache — no host-contract / `attachPrecomputedCompact132Host`
 * crutch.
 *
 * Runs auto-compact in the BACKGROUND ahead of the prompt-token-limit (PTL)
 * so that when a 413 prompt-too-long actually lands, the ready compact result
 * is swapped in instead of paying the full reactive-compact latency.
 *
 * Bundle symbol map (144 `cli.js`, module formerly `qY6`):
 *   `YI6`      -> isPrecomputedCompactEnabled  (gate `tengu_sepia_moth`)
 *   `Kw8`      -> isReactiveFallbackEnabled    (gate `tengu_cobalt_raccoon`)
 *   `$w8`      -> isCompactQuerySource         (144-NEW gate term, `=== 'compact'`)
 *   `Mj`       -> normalizeQuerySource         (144-NEW, collapses `agent:custom:*`)
 *   `gt7`      -> shouldStartPrecomputedCompact (scheduling decision)
 *   `dt7`      -> startPrecomputedCompact       (schedule + cache)
 *   `eM8`      -> settlePrecomputedCompact      (atomic pending->ready/failed/null)
 *   `p45`      -> getSelfEntry / getPrecomputedCompactStatus
 *   `Hw8`      -> agentKey
 *   `U45`      -> awaitBorrowInflight           (144-NEW, PTL-borrow)
 *   `F45`      -> awaitSelfInflight             (144 rewrite of 132 `x$_`)
 *   `ct7`      -> consumePrecomputedCompact     (144 `kind`-outcome restructure)
 *   `Q45`      -> messagesSinceUuid
 *   `lt7`      -> discardPrecomputedCompactResult (144 adds `querySource` field)
 *   `qw8`      -> discardAgentPrecomputedCompact
 *   `db`       -> precomputedCompactCache
 *   `m45`      -> buildConsumeFailure           (144-NEW, failure payload)
 *
 * Telemetry (verbatim from the 2.1.144 bundle):
 *   tengu_precomputed_compact_started / _ready / _failed / _discarded / _consumed
 *   tengu_precompute_borrow_boundary_miss
 * plus `tengu_feature_ok|bad|sad` for `compact_precomputed`.
 *
 * The 144 consume path reads and writes the SAME per-agent cache the 132 body
 * owns (`precomputedCompactCache`), so a background precompute started by
 * `startPrecomputedCompact` is exactly what `consumePrecomputedCompact` awaits
 * and swaps in. The consume entry point is called directly from the query loop
 * on a PTL turn (bundle `ct7`), matching 144 — there is no separate
 * `tryPrecomputedSwap` wrapper in 144.
 *
 * The summarize leaf runs the real auto-compact (`compactConversation`) in a
 * detached context so the background pass does not drive the main turn's
 * compact-progress / SDK-status UI. The PreCompact hook is honored inside
 * `compactConversation`; a blocking hook throws `CompactionBlockedError`,
 * which is caught here and turns into a discard (the "Precomputed compact
 * blocked by PreCompact hook" interception).
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getIsInteractive } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { CompactProgressEvent, ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
} from './autoCompact.js'
import {
  CompactionBlockedError,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type CompactionResult,
} from './compact.js'

/**
 * Bundle `db`/`Fc` — per-agent cache of in-flight / ready / failed
 * precomputed compacts.
 *
 * 144 adds a `failed` state to the 132 `pending`/`ready` pair: a failed
 * background precompute is now SETTLED (kept, tagged `failed`) rather than
 * deleted, so a later PTL consume can record a `kind: 'failed'` outcome and the
 * next schedule pass may retry (a `failed` entry does not block a restart).
 */
type PrecomputedCompactEntry =
  | {
      status: 'pending'
      precomputedAtUuid: string
      preCompactTokens: number
      startedAt: number
      abortController: AbortController
      preCompactHookDisplay: string | undefined
      settled: Promise<void>
    }
  | {
      status: 'ready'
      precomputedAtUuid: string
      preCompactTokens: number
      startedAt: number
      abortController: AbortController
      preCompactHookDisplay: string | undefined
      readyDurationMs: number
      result: CompactionResult
    }
  | {
      status: 'failed'
      precomputedAtUuid: string
      preCompactTokens: number
      startedAt: number
      abortController: AbortController
      preCompactHookDisplay: string | undefined
      failure: PrecomputedConsumeFailure
    }

const precomputedCompactCache = new Map<string, PrecomputedCompactEntry>()

// ---------------------------------------------------------------------------
// Gates & key helpers (132 body; 144 adds `Mj` + the `$w8` term)
// ---------------------------------------------------------------------------

/** Bundle `Hw8`/`Se$` — agent key; main thread is 'main'. */
export function agentKey(agentId?: string): string {
  return agentId ?? 'main'
}

/**
 * Bundle `Kw8` — reactive-compact fallback enabled. In this tree the
 * reactive-only and reactive-fallback gates both resolve to
 * `tengu_cobalt_raccoon` (see autoCompact.ts), consulted only in
 * non-interactive sessions.
 */
export function isReactiveFallbackEnabled(): boolean {
  if (getIsInteractive()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)
}

/**
 * Bundle `YI6` — the precomputed-compact subsystem gate. Auto-compact must be
 * on, reactive-fallback must be off, and `tengu_sepia_moth` (default off) must
 * be on.
 */
export function isPrecomputedCompactEnabled(): boolean {
  if (!isAutoCompactEnabled()) {
    return false
  }
  if (isReactiveFallbackEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_sepia_moth', false)
}

/**
 * Bundle `$w8` — 144-NEW gate term: never precompute / consume for the compact
 * fork itself. 132 expressed this via `isCompactQuerySource`; 144 promotes it
 * to the named `$w8` term and folds it into the consume gate.
 */
export function isCompactQuerySource(querySource: QuerySource | undefined): boolean {
  return querySource === 'compact'
}

/**
 * Bundle `Mj` — 144-NEW querySource normalizer; collapses `agent:custom:*`
 * into `agent:custom` for telemetry. Passes every other value (incl.
 * `undefined`) through unchanged.
 */
export function normalizeQuerySource(
  querySource: QuerySource | undefined,
): QuerySource | undefined {
  if (querySource !== undefined && querySource.startsWith('agent:custom:')) {
    return 'agent:custom'
  }
  return querySource
}

// ---------------------------------------------------------------------------
// 144-NEW telemetry payload types (verbatim field names from bundle `ct7`)
// ---------------------------------------------------------------------------

/**
 * 144-NEW — the consume outcome discriminator. The 132 consume returned a bare
 * `{ ready, statusAtPTL } | null`; 144 wraps the result in a `kind`-tagged
 * outcome so the `tengu_precomputed_compact_consumed` event can record which
 * path the turn took.
 */
export type PrecomputedConsumeOutcomeKind =
  | 'none'
  | 'applied'
  | 'failed'
  | 'aborted'

/**
 * 144-NEW — failure payload carried by a `kind: 'failed'` outcome and the
 * `failure*` fields spread into the consumed event. Built from a summarize
 * failure by {@link buildConsumeFailure} (bundle `m45`). Field names verbatim.
 */
export type PrecomputedConsumeFailure = {
  reason: string
  cause: string
  status: string
  attempts: number
  durationMs: number
}

/**
 * 144-NEW — the swap applied on `kind: 'applied'`. Field names verbatim from the
 * bundle; 144 adds `borrowed` to the 132 swap shape.
 */
export type PrecomputedSwap = {
  compactResult: CompactionResult
  preCompactHookDisplay: string | undefined
  messagesSince: Message[]
  /** `'pending' | 'ready'` — coerced from the in-flight entry `statusAtPTL`. */
  statusAtPTL: 'pending' | 'ready'
  /** `ptlDetectedAt - ready.startedAt` (how early the precompute finished). */
  leadMs: number
  /** `ready.readyDurationMs` — how long the precompute ran. */
  totalMs: number
  /** 144-NEW — true when the swap came from the `borrowFrom` borrow path. */
  borrowed: boolean
}

/**
 * 144-NEW — a `kind`-tagged consume outcome. Only the branch-specific fields
 * are present, mirroring the bundle's `Y(outcome, emittedEarlyCompactStart)`
 * closure.
 */
export type PrecomputedConsumeOutcome =
  | { kind: 'none' }
  | { kind: 'aborted' }
  | { kind: 'applied'; swap: PrecomputedSwap }
  | {
      kind: 'failed'
      failure: PrecomputedConsumeFailure
      statusAtPTL: string
    }

/**
 * 144-NEW — the consume return shape. `swap` is only populated when
 * `outcome.kind === 'applied'` (otherwise `undefined`, = bundle `void 0`), and
 * `emittedEarlyCompactStart` is the `M` flag captured at call time.
 */
export type PrecomputedConsumeResult = {
  outcome: PrecomputedConsumeOutcome
  swap: PrecomputedSwap | undefined
  emittedEarlyCompactStart: boolean
}

/**
 * 144-NEW — consume input. `borrowFrom` and `querySource` are 144-NEW; the rest
 * map onto the 132 consume input plus the two reactive guards the gate reads.
 */
export type PrecomputedConsumeInput = {
  toolUseContext: ToolUseContext
  messages: Message[]
  /** `performance.now()` timestamp at which PTL was detected (bundle `K`). */
  ptlDetectedAt: number
  /**
   * 144-NEW — db key of the borrowed agent whose precomputed entry should be
   * awaited/consumed in flight (PTL-borrow, bundle `U45`). Absent for the plain
   * self path.
   */
  borrowFrom?: string
  /**
   * 144-NEW — the caller's query source. The gate reads the RAW value via
   * `isCompactQuerySource`; the consumed/boundary-miss/discard events read the
   * `Mj`-normalized value.
   */
  querySource?: QuerySource
  isWithheld413: boolean
  hasAttemptedReactiveCompact: boolean
}

// ---------------------------------------------------------------------------
// 144-NEW — the unified compact-event callback (bundle `onCompactEvent`)
// ---------------------------------------------------------------------------

/**
 * 144-NEW — the unified compact-event callback the consume path emits while a
 * precompute is still pending. This is the 144-wide context-surface
 * unification that folds the 132 `onCompactProgress` + `setSDKStatus` pair into
 * a single dispatcher. That dispatcher is a separate, 144-wide `ToolUseContext`
 * refactor that is not on this tree's context yet, so the consume path reaches
 * it through a local structural cast (the same pattern the 144 delta used)
 * rather than importing a symbol that does not exist in-tree.
 */
// The sdk_status value type is derived from the tree's existing
// `ToolUseContext.setSDKStatus` (whose argument is the SDK status union) so
// this module does not need to import the SDK status type by name.
type ToolUseContextSdkStatus = Parameters<
  NonNullable<ToolUseContext['setSDKStatus']>
>[0]

export type PrecomputedCompactEvent =
  | { type: 'compact_progress'; event: CompactProgressEvent }
  | { type: 'sdk_status'; status: ToolUseContextSdkStatus | null }

type ToolUseContextWith144CompactEvent = ToolUseContext & {
  onCompactEvent?: (event: PrecomputedCompactEvent) => void
}

// ---------------------------------------------------------------------------
// Feature ok/bad/sad (132 body, unchanged)
// ---------------------------------------------------------------------------

function logPrecomputedFeatureOk(): void {
  logEvent('tengu_feature_ok', {
    feature_name:
      'compact_precomputed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function logPrecomputedFeatureBad(reason: string): void {
  logEvent('tengu_feature_bad', {
    feature_name:
      'compact_precomputed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code: `compact_precomputed_${reason}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function logPrecomputedFeatureSad(reason: string): void {
  logEvent('tengu_feature_sad', {
    feature_name:
      'compact_precomputed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code: `compact_precomputed_${reason}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Bundle `C$_` — a detached tool-use context for the background pass: its own
 * abort controller and no compact-progress / SDK-status callbacks (the main
 * turn owns those signals).
 */
function detachedToolUseContext(
  context: ToolUseContext,
  abortController: AbortController,
): ToolUseContext {
  return {
    ...context,
    abortController,
    onCompactProgress: undefined,
    setSDKStatus: undefined,
  }
}

// ---------------------------------------------------------------------------
// Schedule decision & start (132 body; 144 `dt7` adds the `$w8` term + retry-
// after-failure, and the `querySource`/`precomputeAttemptNumber` event fields)
// ---------------------------------------------------------------------------

/**
 * Bundle `gt7` — decide whether to kick off a precomputed compact this turn.
 * Skips when: a compact already produced results, the reactive path has
 * failures, we already attempted reactive, the previous continue was a swap,
 * we are the compact fork itself (144 `$w8` term), the subsystem is off,
 * reactive-fallback is disabled, or we're not yet in the compact/blocked band.
 */
export function shouldStartPrecomputedCompact(args: {
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  hasAttemptedReactiveCompact: boolean
  lastTransitionReason?: string
  isReactiveFallbackEnabled: boolean
  querySource?: QuerySource
  contextTokens: number
  model: string
}): boolean {
  const {
    compactionResult,
    consecutiveFailures,
    hasAttemptedReactiveCompact,
    lastTransitionReason,
    isReactiveFallbackEnabled: reactiveFallback,
    querySource,
    contextTokens,
    model,
  } = args
  if (compactionResult !== undefined) {
    return false
  }
  if (consecutiveFailures !== undefined) {
    return false
  }
  if (hasAttemptedReactiveCompact) {
    return false
  }
  if (lastTransitionReason === 'precomputed_compact_swap') {
    return false
  }
  if (isCompactQuerySource(querySource)) {
    return false
  }
  if (!isPrecomputedCompactEnabled()) {
    return false
  }
  if (!reactiveFallback) {
    return false
  }
  const { isAtBlockingLimit, isAboveAutoCompactThreshold } =
    calculateTokenWarningState(contextTokens, model)
  return isAtBlockingLimit || isAboveAutoCompactThreshold
}

/**
 * Bundle `dt7` — schedule a background precomputed compact for the agent,
 * caching a `pending` entry that resolves to `ready` (CompactionResult) or is
 * settled as `failed` on error (144) or discarded (deleted) on abort /
 * PreCompact-hook block. A `failed` entry does not block a restart, so a later
 * turn may retry (the 132 `has(key)` check becomes `has(key) && status!=='failed'`).
 * Returns true if a new precompute was started, false otherwise.
 */
export function startPrecomputedCompact(args: {
  querySource: QuerySource
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): boolean {
  const { querySource, messages, cacheSafeParams } = args
  const { toolUseContext } = cacheSafeParams
  const key = agentKey(toolUseContext.agentId)
  if (!isPrecomputedCompactEnabled()) {
    return false
  }
  if (isCompactQuerySource(querySource)) {
    return false
  }
  // 144: a `failed` entry is restartable (132 deleted failures, so `has` alone
  // sufficed; 144 keeps them, so only `pending`/`ready` block a restart).
  const existing = precomputedCompactCache.get(key)
  if (existing !== undefined && existing.status !== 'failed') {
    return false
  }
  const precomputedAtUuid = messages.at(-1)?.uuid
  if (precomputedAtUuid === undefined) {
    return false
  }

  const abortController = new AbortController()
  const startedAt = performance.now()
  const preCompactTokens = tokenCountWithEstimation(messages)
  const detachedContext = detachedToolUseContext(toolUseContext, abortController)
  const detachedParams: CacheSafeParams = {
    ...cacheSafeParams,
    toolUseContext: detachedContext,
  }
  // 144 event fields: normalized querySource + per-agent attempt counter.
  const normalizedSource = normalizeQuerySource(querySource)

  logEvent('tengu_precomputed_compact_started', {
    preCompactTokens,
    messageCount: messages.length,
    querySource: normalizedSource as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
  })
  logForDebugging(
    `precomputed compact: started (${key}, ${messages.length} msgs, ~${preCompactTokens} tok)`,
  )

  const settled = (async () => {
    let summary: CompactionResult
    try {
      summary = await compactConversation(
        messages,
        detachedContext,
        detachedParams,
        true, // suppress follow-up questions (background pass)
        undefined,
        true, // isAutoCompact
      )
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt)
      if (error instanceof CompactionBlockedError) {
        logForDebugging(
          `Precomputed compact blocked by PreCompact hook: ${error.message}`,
        )
        settlePrecomputedCompact(key, abortController, null)
        return
      }
      if (hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
        logForDebugging(
          `precomputed compact: failed (aborted) (${key}, ${durationMs}ms)`,
        )
        logEvent('tengu_precomputed_compact_failed', {
          reason:
            'aborted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs,
          querySource: normalizedSource as
            | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            | undefined,
        })
        logPrecomputedFeatureSad('aborted')
        settlePrecomputedCompact(key, abortController, null)
        return
      }
      const reason = 'error'
      logForDebugging(
        `precomputed compact: failed (${reason}) (${key}, ${durationMs}ms)`,
      )
      logEvent('tengu_precomputed_compact_failed', {
        reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
        querySource: normalizedSource as
          | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          | undefined,
      })
      logPrecomputedFeatureBad(reason)
      // 144: settle to `failed` (kept, tagged) rather than delete, so a PTL
      // consume can record a `kind: 'failed'` outcome.
      settlePrecomputedCompact(key, abortController, entry => ({
        status: 'failed',
        precomputedAtUuid: entry.precomputedAtUuid,
        preCompactTokens: entry.preCompactTokens,
        startedAt: entry.startedAt,
        abortController: entry.abortController,
        preCompactHookDisplay: entry.preCompactHookDisplay,
        failure: {
          reason,
          cause: reason,
          status: reason,
          attempts: 0,
          durationMs,
        },
      }))
      return
    }
    if (abortController.signal.aborted) {
      settlePrecomputedCompact(key, abortController, null)
      return
    }
    const durationMs = Math.round(performance.now() - startedAt)
    logForDebugging(
      `precomputed compact: ready (${key}, ${durationMs}ms)`,
    )
    logEvent('tengu_precomputed_compact_ready', {
      durationMs,
      preCompactTokens,
      messageCount: messages.length,
      querySource: normalizedSource as
        | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        | undefined,
    })
    logPrecomputedFeatureOk()
    settlePrecomputedCompact(key, abortController, entry => ({
      status: 'ready',
      precomputedAtUuid: entry.precomputedAtUuid,
      preCompactTokens: entry.preCompactTokens,
      startedAt: entry.startedAt,
      abortController: entry.abortController,
      preCompactHookDisplay: summary.userDisplayMessage,
      readyDurationMs: durationMs,
      result: summary,
    }))
  })()

  precomputedCompactCache.set(key, {
    status: 'pending',
    precomputedAtUuid,
    preCompactTokens,
    startedAt,
    abortController,
    preCompactHookDisplay: undefined,
    settled,
  })
  return true
}

/**
 * Bundle `eM8` — atomically transition a `pending` entry to `ready`/`failed`
 * (`update`) or delete it (`null`), guarded by abort-controller identity so a
 * superseded entry is never mutated.
 */
function settlePrecomputedCompact(
  key: string,
  expectedController: AbortController,
  update:
    | null
    | ((entry: Extract<PrecomputedCompactEntry, { status: 'pending' }>) => PrecomputedCompactEntry),
): void {
  const entry = precomputedCompactCache.get(key)
  if (entry?.status !== 'pending' || entry.abortController !== expectedController) {
    return
  }
  if (update === null) {
    precomputedCompactCache.delete(key)
    return
  }
  precomputedCompactCache.set(key, update(entry))
}

// ---------------------------------------------------------------------------
// Consume path (132 body cache; 144 `ct7` `kind`-outcome restructure + borrow)
// ---------------------------------------------------------------------------

/** Bundle `p45`/`b$_` — read an agent's precomputed-compact cache status. */
export function getPrecomputedCompactStatus(
  agentId?: string,
): 'pending' | 'ready' | 'failed' | undefined {
  return precomputedCompactCache.get(agentKey(agentId))?.status
}

/** Bundle `Q45`/`u$_` — messages strictly after the given uuid, minus progress. */
export function messagesSinceUuid(
  messages: Message[],
  uuid: string,
): Message[] | null {
  const index = messages.findIndex(m => m.uuid === uuid)
  if (index === -1) {
    return null
  }
  return messages.slice(index + 1).filter(m => m.type !== 'progress')
}

/**
 * Bundle `U45` — 144-NEW. Await/consume a *borrowed* in-flight entry by db key
 * (PTL-borrow). Unlike the self path (`F45`), the borrow does NOT delete the
 * borrowed agent's entry — it only reads it, so the owning agent can still
 * consume its own result. Returns null if absent/aborted; `turn_aborted` if the
 * turn's signal aborted while awaiting; `ready` if the entry settled ready.
 */
async function awaitBorrowInflight(
  borrowKey: string,
  signal: AbortSignal,
): Promise<
  | {
      kind: 'ready'
      ready: Extract<PrecomputedCompactEntry, { status: 'ready' }>
      statusAtPTL: string
    }
  | { kind: 'turn_aborted'; statusAtPTL: string }
  | null
> {
  const entry = precomputedCompactCache.get(borrowKey)
  if (entry === undefined || signal.aborted) {
    return null
  }
  const statusAtPTL = entry.status
  if (entry.status === 'pending') {
    logForDebugging(
      `precomputed compact: awaiting borrowed in-flight (${borrowKey})`,
    )
    const turnAborted = await Promise.race([
      entry.settled.then(() => false),
      new Promise<boolean>(resolve => {
        signal.addEventListener('abort', () => resolve(true), { once: true })
      }),
    ])
    if (turnAborted) {
      logForDebugging(
        `precomputed compact: turn aborted while borrowing (${borrowKey}) — leaving entry`,
      )
      return { kind: 'turn_aborted', statusAtPTL }
    }
  }
  const after = precomputedCompactCache.get(borrowKey)
  logForDebugging(
    `precomputed compact: borrowed (${borrowKey}, ${after?.status ?? 'gone'})`,
  )
  if (after?.status === 'ready') {
    return { kind: 'ready', ready: after, statusAtPTL }
  }
  return null
}

/**
 * Bundle `F45` — 144 rewrite of the 132 `x$_` self-consume. Await the
 * self-agent in-flight entry (racing the turn's abort), then delete it and
 * return a `kind`-tagged result: `ready` / `failed` / `turn_aborted`, or `null`
 * when nothing is (or remains) consumable.
 */
async function awaitSelfInflight(
  agentId: string | undefined,
  signal: AbortSignal,
): Promise<
  | {
      kind: 'ready'
      ready: Extract<PrecomputedCompactEntry, { status: 'ready' }>
      statusAtPTL: string
    }
  | {
      kind: 'failed'
      failure: PrecomputedConsumeFailure
      statusAtPTL: string
    }
  | { kind: 'turn_aborted'; statusAtPTL: string }
  | null
> {
  const key = agentKey(agentId)
  const entry = precomputedCompactCache.get(key)
  if (entry === undefined || signal.aborted) {
    return null
  }
  const statusAtPTL = entry.status
  if (entry.status === 'pending') {
    logForDebugging(`precomputed compact: awaiting in-flight (${key})`)
    const turnAborted = await Promise.race([
      entry.settled.then(() => false),
      new Promise<boolean>(resolve => {
        signal.addEventListener('abort', () => resolve(true), { once: true })
      }),
    ])
    if (turnAborted) {
      logForDebugging(
        `precomputed compact: turn aborted while awaiting (${key}) — leaving entry`,
      )
      return { kind: 'turn_aborted', statusAtPTL }
    }
  }
  const after = precomputedCompactCache.get(key)
  precomputedCompactCache.delete(key)
  logForDebugging(
    `precomputed compact: consumed (${key}, ${after?.status ?? 'gone'})`,
  )
  switch (after?.status) {
    case 'ready':
      return { kind: 'ready', ready: after, statusAtPTL }
    case 'failed':
      return { kind: 'failed', failure: after.failure, statusAtPTL }
    case 'pending':
    case undefined:
      return null
  }
}

/**
 * Bundle `m45` — 144-NEW. Build the consume failure payload from a summarize
 * failure. `cause` collapses the reason: `error` -> `timeout`/`api_error`
 * (by `isTimeout`), else the reason verbatim.
 */
export function buildConsumeFailure(failure: {
  reason: string
  isTimeout?: boolean
  attempts: number
  status: string
  detail?: string
}, durationMs: number): PrecomputedConsumeFailure {
  const cause =
    failure.reason === 'error'
      ? failure.isTimeout
        ? 'timeout'
        : 'api_error'
      : failure.reason
  return {
    reason: failure.reason,
    cause,
    status: failure.status,
    attempts: failure.attempts,
    durationMs,
  }
}

/**
 * Build the `tengu_precomputed_compact_consumed` payload for a given outcome.
 * Field names and the `kind`-conditional spread are verbatim from the bundle
 * `ct7` `Y` closure:
 *
 * ```js
 * d("tengu_precomputed_compact_consumed", {
 *   kind: X.kind,
 *   querySource: z,          // Mj(A)
 *   waitedMs: P,             // Math.round(performance.now() - K)
 *   statusAtPTL: Z,          // applied->swap.statusAtPTL / failed->statusAtPTL / else void 0
 *   ...(X.kind === "applied" && { borrowed: X.swap.borrowed, precomputeTotalMs: Math.round(X.swap.totalMs) }),
 *   ...(X.kind === "failed"  && { failureReason, failureCause, failureStatus, failureAttempts, failureDurationMs })
 * })
 * ```
 */
export function buildPrecomputedCompactConsumedPayload(
  outcome: PrecomputedConsumeOutcome,
  querySource: QuerySource | undefined,
  ptlDetectedAt: number,
): Record<string, boolean | number | undefined> {
  // `waitedMs`: how long the turn waited from PTL detection to consume.
  const waitedMs = Math.round(performance.now() - ptlDetectedAt)
  // `statusAtPTL`: applied->swap.statusAtPTL, failed->statusAtPTL, else undefined.
  const statusAtPTL =
    outcome.kind === 'applied'
      ? outcome.swap.statusAtPTL
      : outcome.kind === 'failed'
        ? outcome.statusAtPTL
        : undefined

  return {
    kind: outcome.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: querySource as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    waitedMs,
    statusAtPTL: statusAtPTL as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    // 144 applied branch: `borrowed` + `precomputeTotalMs` (= round(totalMs)).
    ...(outcome.kind === 'applied' && {
      borrowed: outcome.swap.borrowed,
      precomputeTotalMs: Math.round(outcome.swap.totalMs),
    }),
    // 144 failed branch: the five `failure*` fields, verbatim.
    ...(outcome.kind === 'failed' && {
      failureReason: outcome.failure.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      failureCause: outcome.failure.cause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      failureStatus: outcome.failure.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      failureAttempts: outcome.failure.attempts,
      failureDurationMs: outcome.failure.durationMs,
    }),
  }
}

/**
 * Bundle `lt7`/`FsK` — discard a ready result, emitting
 * `tengu_precomputed_compact_discarded`. 144 adds the (normalized) `querySource`
 * field to the 132 event. Takes the RAW querySource and normalizes internally.
 */
export function discardPrecomputedCompactResult(
  ready: Extract<PrecomputedCompactEntry, { status: 'ready' }>,
  reason: string,
  querySource: QuerySource | undefined = undefined,
): void {
  logEvent('tengu_precomputed_compact_discarded', {
    reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ageMs: Math.round(performance.now() - ready.startedAt),
    readyDurationMs: ready.readyDurationMs,
    preCompactTokens: ready.preCompactTokens,
    querySource: normalizeQuerySource(querySource) as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
  })
  logForDebugging(
    `precomputed compact: discarded (${reason}, age ${Math.round(performance.now() - ready.startedAt)}ms)`,
  )
}

/**
 * Bundle `qw8`/`Re$` — abort a pending entry and/or discard a ready one, then
 * drop it from the cache.
 */
export function discardAgentPrecomputedCompact(
  agentId: string | undefined,
  reason: string,
): void {
  const key = agentKey(agentId)
  const entry = precomputedCompactCache.get(key)
  if (entry?.status === 'ready') {
    discardPrecomputedCompactResult(entry, reason)
  }
  entry?.abortController.abort()
  precomputedCompactCache.delete(key)
}

/**
 * Bundle `ct7` — the 144 consume fn: the 144 `kind`-outcome restructure on the
 * 132 body. Verbatim control flow from the bundle:
 *
 * ```js
 * async function ct7(H){
 *   let { toolUseContext:$, messages:q, ptlDetectedAt:K, borrowFrom:_, querySource:A } = H,
 *       z = Mj(A),
 *       Y = (X, L) => {
 *         let P = Math.round(performance.now() - K),
 *             Z = X.kind==="applied" ? X.swap.statusAtPTL : X.kind==="failed" ? X.statusAtPTL : void 0;
 *         return d("tengu_precomputed_compact_consumed", {
 *                  kind: X.kind, querySource: z, waitedMs: P, statusAtPTL: Z,
 *                  ...X.kind==="applied" && { borrowed: X.swap.borrowed, precomputeTotalMs: Math.round(X.swap.totalMs) },
 *                  ...X.kind==="failed"  && { failureReason, failureCause, failureStatus, failureAttempts, failureDurationMs }
 *                }),
 *                { outcome: X, swap: X.kind==="applied" ? X.swap : void 0, emittedEarlyCompactStart: L }
 *       };
 *   if (!(H.isWithheld413 && !H.hasAttemptedReactiveCompact && !$w8(A) && YI6()))
 *     return { outcome: { kind: "none" }, swap: void 0, emittedEarlyCompactStart: !1 };  // NOTE: no event on gate-off
 *   let O = $.abortController.signal,
 *       M = (_ !== void 0 ? db.get(_) : p45($.agentId))?.status === "pending";
 *   if (M) $.onCompactEvent?.({type:"compact_progress",event:{type:"compact_start"}}),
 *          $.onCompactEvent?.({type:"sdk_status",status:"compacting"});
 *   let w = null, D = !1;
 *   if (_ !== void 0) { w = await U45(_, O); D = w !== null }
 *   if (w ??= await F45($.agentId, O), w === null) return Y({ kind: "none" }, M)
 *   if (w.kind === "turn_aborted") return Y({ kind: "aborted" }, M)
 *   if (w.kind === "failed")     return Y({ kind: "failed", failure: w.failure, statusAtPTL: w.statusAtPTL }, M)
 *   let j = Q45(q, w.ready.precomputedAtUuid);
 *   if (j === null) {
 *     if (D) d("tengu_precompute_borrow_boundary_miss", { querySource: z });
 *     else   lt7(w.ready, "boundary_uuid_missing", A);
 *     return Y({ kind: "none" }, M)
 *   }
 *   let J = w.statusAtPTL === "pending" ? "pending" : "ready";
 *   return Y({ kind: "applied", swap: {
 *     compactResult: w.ready.result,
 *     preCompactHookDisplay: w.ready.preCompactHookDisplay,
 *     messagesSince: j,
 *     statusAtPTL: J,
 *     leadMs: K - w.ready.startedAt,
 *     totalMs: w.ready.readyDurationMs,
 *     borrowed: D }}, M)
 * }
 * ```
 */
export async function consumePrecomputedCompact(
  input: PrecomputedConsumeInput,
): Promise<PrecomputedConsumeResult> {
  const toolUseContext = input.toolUseContext
  const messages = input.messages
  const ptlDetectedAt = input.ptlDetectedAt
  const borrowFrom = input.borrowFrom
  // `z = Mj(A)` — normalized querySource for the telemetry events.
  const normalizedSource = normalizeQuerySource(input.querySource)

  // The 144 consume wrapper `Y(outcome, emittedEarlyCompactStart)`: emit the
  // `tengu_precomputed_compact_consumed` event and return the restructured
  // `{ outcome, swap, emittedEarlyCompactStart }`.
  const emitConsumedAndBuildResult = (
    outcome: PrecomputedConsumeOutcome,
    emittedEarlyCompactStart: boolean,
  ): PrecomputedConsumeResult => {
    logEvent(
      'tengu_precomputed_compact_consumed',
      buildPrecomputedCompactConsumedPayload(
        outcome,
        normalizedSource,
        ptlDetectedAt,
      ),
    )
    return {
      outcome,
      swap: outcome.kind === 'applied' ? outcome.swap : undefined,
      emittedEarlyCompactStart,
    }
  }

  // 144 gate (bundle):
  //   !(isWithheld413 && !hasAttemptedReactiveCompact
  //       && !isCompactQuerySource(querySource) && isPrecomputedCompactEnabled())
  // The gate reads the RAW querySource. On gate-off return `none` WITHOUT
  // emitting the consumed event — matching the bundle's early return.
  if (
    !(
      input.isWithheld413 &&
      !input.hasAttemptedReactiveCompact &&
      !isCompactQuerySource(input.querySource) &&
      isPrecomputedCompactEnabled()
    )
  ) {
    return {
      outcome: { kind: 'none' },
      swap: undefined,
      emittedEarlyCompactStart: false,
    }
  }

  const abortSignal = toolUseContext.abortController.signal

  // `M`: is the relevant entry still in-flight (pending)? Borrow entry if
  // `borrowFrom` is set, else the self entry by agentId.
  const pendingEntry =
    borrowFrom !== undefined
      ? precomputedCompactCache.get(borrowFrom)
      : precomputedCompactCache.get(agentKey(toolUseContext.agentId))
  const emittedEarlyCompactStart = pendingEntry?.status === 'pending'

  // 144: the unified `onCompactEvent` surfaces `compact_start` + `compacting`
  // while a pending entry is being consumed. (The dispatcher is a 144-wide
  // ToolUseContext refactor not yet on this tree, so reach it via the local
  // structural cast.)
  if (emittedEarlyCompactStart) {
    const with144Event = toolUseContext as ToolUseContextWith144CompactEvent
    with144Event.onCompactEvent?.({
      type: 'compact_progress',
      event: { type: 'compact_start' },
    })
    with144Event.onCompactEvent?.({ type: 'sdk_status', status: 'compacting' })
  }

  // Borrow path (144-NEW): await the borrowed entry in flight, tracking whether
  // it actually produced a consumable entry (`borrowed`).
  let consumed:
    | {
        kind: 'ready'
        ready: Extract<PrecomputedCompactEntry, { status: 'ready' }>
        statusAtPTL: string
      }
    | {
        kind: 'failed'
        failure: PrecomputedConsumeFailure
        statusAtPTL: string
      }
    | { kind: 'turn_aborted'; statusAtPTL: string }
    | null = null
  let borrowed = false
  if (borrowFrom !== undefined) {
    consumed = await awaitBorrowInflight(borrowFrom, abortSignal)
    borrowed = consumed !== null
  }
  // Self path: consume our own in-flight entry (144 `F45`) when the borrow did
  // not already yield an entry.
  if (consumed === null) {
    consumed = await awaitSelfInflight(toolUseContext.agentId, abortSignal)
  }

  if (consumed === null) {
    return emitConsumedAndBuildResult({ kind: 'none' }, emittedEarlyCompactStart)
  }
  if (consumed.kind === 'turn_aborted') {
    return emitConsumedAndBuildResult({ kind: 'aborted' }, emittedEarlyCompactStart)
  }
  if (consumed.kind === 'failed') {
    return emitConsumedAndBuildResult(
      {
        kind: 'failed',
        failure: consumed.failure,
        statusAtPTL: consumed.statusAtPTL,
      },
      emittedEarlyCompactStart,
    )
  }

  // `consumed.kind === 'ready'`: slice the live messages after the precomputed
  // boundary uuid; if the uuid has vanished, this is a boundary miss.
  const messagesSince = messagesSinceUuid(
    messages,
    consumed.ready.precomputedAtUuid,
  )
  if (messagesSince === null) {
    if (borrowed) {
      // 144-NEW: borrow succeeded but the boundary uuid is gone — telemetry only
      // (do NOT discard the borrowed agent's entry; it still owns it).
      logEvent('tengu_precompute_borrow_boundary_miss', {
        querySource: normalizedSource as
          | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          | undefined,
      })
    } else {
      // 132 surface: discard the ready entry (144 adds the querySource field).
      // `discardPrecomputedCompactResult` normalizes internally, pass RAW.
      discardPrecomputedCompactResult(
        consumed.ready,
        'boundary_uuid_missing',
        input.querySource,
      )
    }
    return emitConsumedAndBuildResult({ kind: 'none' }, emittedEarlyCompactStart)
  }

  // `applied`: coerce statusAtPTL into 'pending' | 'ready' and build the swap
  // (144 adds `borrowed` to the swap).
  const appliedStatusAtPTL =
    consumed.statusAtPTL === 'pending' ? 'pending' : 'ready'
  return emitConsumedAndBuildResult(
    {
      kind: 'applied',
      swap: {
        compactResult: consumed.ready.result,
        preCompactHookDisplay: consumed.ready.preCompactHookDisplay,
        messagesSince,
        statusAtPTL: appliedStatusAtPTL,
        leadMs: ptlDetectedAt - consumed.ready.startedAt,
        totalMs: consumed.ready.readyDurationMs,
        borrowed,
      },
    },
    emittedEarlyCompactStart,
  )
}

/**
 * Finalize a swap into the post-compact message sequence: boundary + summary +
 * kept tail + the messages that arrived after the precompute + attachments +
 * hook results. (132 surface, unchanged by the 144 consume evolution.)
 */
export function buildPrecomputedSwapMessages(swap: PrecomputedSwap): Message[] {
  const { compactResult, messagesSince } = swap
  return [
    compactResult.boundaryMarker,
    ...compactResult.summaryMessages,
    ...(compactResult.messagesToKeep ?? []),
    ...messagesSince,
    ...compactResult.attachments,
    ...compactResult.hookResults,
  ]
}
