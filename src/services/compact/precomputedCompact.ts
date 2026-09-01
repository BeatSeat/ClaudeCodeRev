/**
 * Precomputed-compact / PTL-borrow / swap subsystem.
 *
 * Official 2.1.132 (bundle module `qY6`). Runs auto-compact in the
 * BACKGROUND ahead of the prompt-token-limit (PTL) so that when a 413
 * prompt-too-long actually lands, the ready compact result is swapped in
 * instead of paying the full reactive-compact latency.
 *
 * Faithful port of the bundle orchestration:
 *   `$Y6`      -> isPrecomputedCompactEnabled  (gate `tengu_sepia_moth`)
 *   `BsK`      -> shouldStartPrecomputedCompact (scheduling decision)
 *   `psK`      -> startPrecomputedCompact       (schedule + cache)
 *   `Ie$`      -> settlePrecomputedCompact      (atomic pending->ready/null)
 *   `b$_`      -> getPrecomputedCompactStatus
 *   `x$_`      -> consumePrecomputedCompact
 *   `UsK`      -> tryPrecomputedSwap            (PTL swap decision)
 *   `u$_`      -> messagesSinceUuid
 *   `FsK`      -> discardPrecomputedCompactResult (emit `_discarded`)
 *   `Re$`      -> discardAgentPrecomputedCompact
 *   `Fc`       -> precomputedCompactCache
 *
 * Telemetry (all 4 events verbatim from the 2.1.132 bundle):
 *   tengu_precomputed_compact_started / _ready / _failed / _discarded
 * plus `tengu_feature_ok|bad|sad` for `compact_precomputed`.
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
import type { ToolUseContext } from '../../Tool.js'
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

/** Bundle `Fc` — per-agent cache of in-flight / ready precomputed compacts. */
const precomputedCompactCache = new Map<string, PrecomputedCompactEntry>()

/** Bundle `Se$` — agent key; main thread is 'main'. */
export function agentKey(agentId?: string): string {
  return agentId ?? 'main'
}

/**
 * Bundle `PY$` — reactive-compact fallback enabled. In this tree the
 * reactive-only (`Ce$`) and reactive-fallback (`PY$`) gates both resolve to
 * `tengu_cobalt_raccoon` (see autoCompact.ts:241), consulted only in
 * non-interactive sessions.
 */
export function isReactiveFallbackEnabled(): boolean {
  if (getIsInteractive()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)
}

/**
 * Bundle `$Y6` — the precomputed-compact subsystem gate. Auto-compact must be
 * on, reactive-only must be off, and `tengu_sepia_moth` (default off) must be
 * on.
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

/** Bundle `R$_` — never precompute for the compact fork itself. */
function isCompactQuerySource(querySource: QuerySource | undefined): boolean {
  return querySource === 'compact'
}

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

/**
 * Bundle `BsK` — decide whether to kick off a precomputed compact this turn.
 * Skips when: a compact already produced results, the reactive path has
 * failures, we already attempted reactive, the previous continue was a swap,
 * the subsystem is off, reactive-fallback is disabled, or we're not yet in
 * the compact/blocked token band.
 */
export function shouldStartPrecomputedCompact(args: {
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  hasAttemptedReactiveCompact: boolean
  lastTransitionReason?: string
  isReactiveFallbackEnabled: boolean
  contextTokens: number
  model: string
}): boolean {
  const {
    compactionResult,
    consecutiveFailures,
    hasAttemptedReactiveCompact,
    lastTransitionReason,
    isReactiveFallbackEnabled: reactiveFallback,
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
 * Bundle `psK` — schedule a background precomputed compact for the agent,
 * caching a `pending` entry that resolves to `ready` (CompactionResult) or is
 * discarded (deleted) on failure / abort / PreCompact-hook block.
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
  if (precomputedCompactCache.has(key)) {
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

  logEvent('tengu_precomputed_compact_started', {
    preCompactTokens,
    messageCount: messages.length,
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
      })
      logPrecomputedFeatureBad(reason)
      settlePrecomputedCompact(key, abortController, null)
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
 * Bundle `Ie$` — atomically transition a `pending` entry to `ready`
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

/** Bundle `b$_` — read an agent's precomputed-compact cache status. */
export function getPrecomputedCompactStatus(
  agentId?: string,
): 'pending' | 'ready' | undefined {
  return precomputedCompactCache.get(agentKey(agentId))?.status
}

/** Bundle `u$_` — messages strictly after the given uuid, minus progress. */
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
 * Bundle `x$_` — consume an agent's precomputed compact: await the in-flight
 * settle (racing the turn's abort), then delete the entry and return the ready
 * result tagged with its status at PTL time. Returns null if not ready.
 */
export async function consumePrecomputedCompact(
  agentId: string | undefined,
  signal: AbortSignal,
): Promise<{
  ready: Extract<PrecomputedCompactEntry, { status: 'ready' }>
  statusAtPTL: 'pending' | 'ready'
} | null> {
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
      return null
    }
  }
  const ready = precomputedCompactCache.get(key)
  precomputedCompactCache.delete(key)
  logForDebugging(
    `precomputed compact: consumed (${key}, ${ready?.status ?? 'gone'})`,
  )
  if (ready?.status !== 'ready') {
    return null
  }
  return { ready, statusAtPTL }
}

export type PrecomputedSwap = {
  compactResult: CompactionResult
  preCompactHookDisplay: string | undefined
  messagesSince: Message[]
  statusAtPTL: 'pending' | 'ready'
  leadMs: number
  totalMs: number
}

export type PrecomputedSwapOutcome = {
  swap: PrecomputedSwap | undefined
  emittedEarlyCompactStart: boolean
}

/**
 * Bundle `UsK` — the PTL swap decision. Only fires on a freshly-withheld 413
 * (not already reactive-attempted) with the subsystem on. Emits an early
 * `compact_start`/`compacting` when a precompute is still pending, consumes
 * the ready result, slices the messages added since precompute, and reports
 * lead/total durations.
 */
export async function tryPrecomputedSwap(args: {
  toolUseContext: ToolUseContext
  messages: Message[]
  isWithheld413: boolean
  hasAttemptedReactiveCompact: boolean
  ptlDetectedAt: number
}): Promise<PrecomputedSwapOutcome> {
  const { toolUseContext, messages, isWithheld413, ptlDetectedAt } = args
  if (!(isWithheld413 && !args.hasAttemptedReactiveCompact && isPrecomputedCompactEnabled())) {
    return { swap: undefined, emittedEarlyCompactStart: false }
  }
  const hadPending = getPrecomputedCompactStatus(toolUseContext.agentId) === 'pending'
  if (hadPending) {
    toolUseContext.onCompactProgress?.({ type: 'compact_start' })
    toolUseContext.setSDKStatus?.('compacting')
  }
  const consumed = await consumePrecomputedCompact(
    toolUseContext.agentId,
    toolUseContext.abortController.signal,
  )
  if (!consumed) {
    return { swap: undefined, emittedEarlyCompactStart: hadPending }
  }
  const messagesSince = messagesSinceUuid(
    messages,
    consumed.ready.precomputedAtUuid,
  )
  if (messagesSince === null) {
    discardPrecomputedCompactResult(consumed.ready, 'boundary_uuid_missing')
    return { swap: undefined, emittedEarlyCompactStart: hadPending }
  }
  return {
    swap: {
      compactResult: consumed.ready.result,
      preCompactHookDisplay: consumed.ready.preCompactHookDisplay,
      messagesSince,
      statusAtPTL: consumed.statusAtPTL,
      leadMs: ptlDetectedAt - consumed.ready.startedAt,
      totalMs: consumed.ready.readyDurationMs,
    },
    emittedEarlyCompactStart: hadPending,
  }
}

/** Bundle `FsK` — discard a ready result and emit `tengu_precomputed_compact_discarded`. */
export function discardPrecomputedCompactResult(
  ready: Extract<PrecomputedCompactEntry, { status: 'ready' }>,
  reason: string,
): void {
  logEvent('tengu_precomputed_compact_discarded', {
    reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ageMs: Math.round(performance.now() - ready.startedAt),
    readyDurationMs: ready.readyDurationMs,
    preCompactTokens: ready.preCompactTokens,
  })
  logForDebugging(
    `precomputed compact: discarded (${reason}, age ${Math.round(performance.now() - ready.startedAt)}ms)`,
  )
}

/** Bundle `Re$` — abort a pending entry and/or discard a ready one, then drop it. */
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
 * Finalize a swap into the post-compact message sequence: boundary + summary
 * + kept tail + the messages that arrived after the precompute + attachments
 * + hook results. Mirrors the bundle `esK` append of `messagesSince` onto the
 * preserved tail.
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
