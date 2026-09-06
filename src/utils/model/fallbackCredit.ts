// Official 2.1.170 refusal-fallback credit mint/forfeit core (gap G4).
//
// This module holds the self-contained, verbatim pieces of the refusal-fallback
// credit lifecycle introduced in 2.1.170 (bundle: tengu_fallback_credit_{
// minted,forfeited,outcome}, fallback_credit_token, the refusal_fallback_prompt
// user-dialog, and the kxK/yxK/ExK/hxK/SxK copy + decision helpers).
//
// The minified source identifiers are mapped to readable names:
//   ExK -> getRefusalFallbackGuidanceText
//   hxK -> getRefusalFallbackSafetyExplanation
//   SxK -> getRefusalFallbackDialogChoiceLabels
//   hx4 -> extractFallbackCreditToken
//   kxK -> classifyRefusalFallbackSuppression
//   yxK -> shouldSilentlyFallBackOnRefusal
//   Za  -> sanitizeRequestIdForTelemetry
//   F_H -> sanitizeModelForTelemetry
//   eH  -> createRefusalFallbackCreditSettler (the once-settled outcome closure)
//
// What is NOT in this module (host machinery absent from the 2.1.170 tree,
// documented as 未覆盖 in the hop report):
//   - The query-loop `fallback_request` / `server_fallback` streaming flow and
//     the `requestDialog` round-trip (the 160-baseline G13 + server-refusal-
//     fallback streaming body). `classifyRefusalFallbackSuppression` and the
//     dialog-kind definition below port the decision logic + dialog contract so
//     that flow can be wired once the host exists.
//   - The mint call-site inside the streaming loop is wired in
//     src/services/api/claude.ts (message_delta); the forfeit + outcome call
//     sites live in the absent query-loop flow.

import type {
  AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../services/analytics/index.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isFirstPartyApiFamily,
} from './providers.js'
import { renderModelName } from './model.js'

// --- Telemetry field sanitizers (bundle ff$/A$/_$/_$/JK/BkH/Za/F_H) -----------
//
// In the official 2.1.170 bundle these funnel through the no-op `ff$(H){return
// H}` and the analytics string-type. `Za` and `F_H` additionally gate on an
// allow-list regex and fall back to the "nonconforming" token, which is what
// keeps model / request ids out of analytics as raw code/paths.

/** Sanitizes a free-form string for a string-typed analytics field (bundle `_$`/`ff$`). */
export function sanitizeForTelemetry(
  value: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/** Null-safe telemetry string: `undefined` passes through as undefined (bundle `JK`). */
export function sanitizeForTelemetryOrNull(
  value: string | null | undefined,
):
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  if (value == null) {
    return undefined
  }
  return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Sanitizes a request id for telemetry (bundle `Za`): only
 * `[A-Za-z0-9_-]{1,128}` is forwarded; anything else collapses to "nonconforming".
 */
export function sanitizeRequestIdForTelemetry(
  value: string | null | undefined,
):
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  if (value == null) {
    return undefined
  }
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return sanitizeForTelemetry('nonconforming')
}

/**
 * Sanitizes a model id for telemetry (bundle `F_H`): only
 * `[A-Za-z0-9._:[\]-]{1,100}` is forwarded; anything else collapses to
 * "nonconforming".
 */
export function sanitizeModelForTelemetry(
  value: string | null | undefined,
):
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  if (value == null) {
    return undefined
  }
  if (/^[A-Za-z0-9._:[\]-]{1,100}$/.test(value)) {
    return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return sanitizeForTelemetry('nonconforming')
}

// --- Usage snapshot for credit telemetry --------------------------------------

/**
 * The usage fields read by the three credit events. Kept structural so the
 * mint call-site in claude.ts can pass its (already-merged) `NonNullableUsage`
 * without the module importing the SDK type.
 */
export interface FallbackCreditUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
  service_tier?: string | null
  speed?: string | null
}

/**
 * Expands a usage snapshot into the token/service_tier/speed telemetry fields
 * shared by the minted and outcome events. Verbatim field set from the 2.1.170
 * bundle: input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, cache_creation_5m_input_tokens
 * (ephemeral_5m_input_tokens ?? 0), cache_creation_1h_input_tokens
 * (ephemeral_1h_input_tokens ?? 0), service_tier, speed.
 */
function fallbackCreditUsageTelemetry(
  usage: FallbackCreditUsage,
): Record<string, number | string | undefined> {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_creation_5m_input_tokens:
      usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cache_creation_1h_input_tokens:
      usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    service_tier: sanitizeForTelemetryOrNull(usage.service_tier),
    speed: sanitizeForTelemetryOrNull(usage.speed),
  }
}

// --- Token extraction + provider gate (bundle hx4 / P_H) ----------------------

/**
 * Extracts the fallback credit token from a refusal `stop_details` object
 * (bundle `hx4`). Returns the string only when it is a non-empty string of
 * length <= 2048; otherwise undefined.
 */
export function extractFallbackCreditToken(
  stopDetails: unknown,
): string | undefined {
  if (typeof stopDetails !== 'object' || stopDetails === null) {
    return undefined
  }
  const token = (stopDetails as { fallback_credit_token?: unknown })
    .fallback_credit_token
  if (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= 2048
  ) {
    return token
  }
  return undefined
}

// --- Refusal-fallback copy (bundle ExK / hxK / SxK + constants) ---------------

/** Support article surfaced in the refusal-fallback safety explanation. */
export const REFUSAL_FALLBACK_SUPPORT_URL =
  'https://support.claude.com/en/articles/15363606'

/** Setting toggle label (bundle `XxK`). */
export const REFUSAL_FALLBACK_SETTING_LABEL =
  'Switch models when a message is flagged'

/** Safety-note copy (bundle `GJ$`). */
export const REFUSAL_FALLBACK_SAFETY_NOTE =
  "They may flag safe, normal content as well. These measures let us bring you Mythos-level capability in other areas sooner, and we're working to refine them."

/** Feedback / learn-more tail (bundle `ZJ$`), interpolated with the support URL. */
const refusalFallbackFeedbackLine = `Send feedback with /feedback or learn more: ${REFUSAL_FALLBACK_SUPPORT_URL}`

/** Feature token for the refusal-fallback retry lane (bundle `bD_`). */
export const REFUSAL_FALLBACK_FEATURE_TOKEN = 'convolute_arcades'

/** Header marker for a refusal-fallback request (bundle `WxK`). */
export const REFUSAL_FALLBACK_REQUEST_HEADER = 'x-is-refusal-fallback'

/** Bundle `xD_` — refusal-fallback numeric bound. */
export const REFUSAL_FALLBACK_BOUND_A = 80

/** Bundle `DxK` — refusal-fallback numeric bound (10 seconds). */
export const REFUSAL_FALLBACK_BOUND_B = 1e4

/**
 * Whether the current session is eligible to mint a fallback credit
 * (bundle `P_H`): the provider is strictly first-party AND the base URL is the
 * official Anthropic endpoint. Verbatim port of `P_H()` / `F_()`.
 */
export function isRefusalFallbackMintEligible(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Guidance text shown with the refusal-fallback prompt (bundle `ExK`).
 * Returns undefined on first-party (the user can already configure models);
 * otherwise the "set ANTHROPIC_DEFAULT_FABLE_MODEL / _OPUS_MODEL" hint.
 *
 * NOTE (未覆盖): the `wf()` first-party check is `provider === 'firstParty' ||
 * provider === 'anthropicAws' || provider === 'gateway'`. The tree has no
 * `gateway` provider in `getAPIProvider()` (see src/utils/model/providers.ts),
 * so this port keys the check on `isFirstPartyApiFamily` (firstParty |
 * anthropicAws). The `gateway` arm is 未覆盖 until a gateway provider exists.
 */
export function getRefusalFallbackGuidanceText(): string | undefined {
  if (isFirstPartyApiFamily()) {
    return undefined
  }
  return (
    'To enable automatic fallback on this provider, set ' +
    '`ANTHROPIC_DEFAULT_FABLE_MODEL` to your Fable 5 model ID and ' +
    '`ANTHROPIC_DEFAULT_OPUS_MODEL` to your Opus 4.8 model ID.'
  )
}

/**
 * Safety explanation body for the refusal-fallback prompt (bundle `hxK`):
 * "<model> has safety measures that flag messages on most cybersecurity or
 * biology topics. <safety note> <feedback line>".
 */
export function getRefusalFallbackSafetyExplanation(model: string): string {
  return (
    `${renderModelName(model)} has safety measures that flag messages on ` +
    `most cybersecurity or biology topics. ${REFUSAL_FALLBACK_SAFETY_NOTE} ` +
    refusalFallbackFeedbackLine
  )
}

/**
 * The two dialog choice labels (bundle `SxK`): `retry_fallback` ->
 * "Switch to <fallbackModel>" and `edit_prompt` -> "Edit prompt and retry with
 * <originalModel>".
 */
export function getRefusalFallbackDialogChoiceLabels(
  originalModel: string,
  fallbackModel: string,
): { retry_fallback: string; edit_prompt: string } {
  return {
    retry_fallback: `Switch to ${renderModelName(fallbackModel)}`,
    edit_prompt: `Edit prompt and retry with ${renderModelName(originalModel)}`,
  }
}

// --- Decision helpers (bundle kxK / yxK) --------------------------------------

/** Inputs shared by the refusal-fallback suppression decision helpers. */
export interface RefusalFallbackDecisionInput {
  /** Whether the silent A/B arm is active (bundle `silentAbArm`). */
  silentAbArm: boolean
  /** Whether this is the main (repl) thread rather than a subagent. */
  isMainThread: boolean
  /**
   * A dialog-capable host callback. `undefined` means the host cannot render
   * the refusal-fallback dialog (bundle `requestDialog === void 0`).
   */
  requestDialog: unknown
  /** The consumer declared it cannot display the dialog. */
  consumerLacksDialogCapability: boolean
}

/**
 * Whether the refusal-fallback prompt is suppressed for the current session
 * (bundle `kxK`). Returns the suppression reason, or undefined when the prompt
 * may be shown. Decision order is verbatim from the bundle:
 *   silentAbArm -> "silent_ab"
 *   !isMainThread -> "subagent"
 *   requestDialog === undefined -> "no_dialog_host"
 *   switchModelsOnFlag === true -> "setting"
 *   consumerLacksDialogCapability -> "no_consumer_capability"
 *
 * NOTE (未覆盖): the `switchModelsOnFlag` setting (the 160-baseline G13) is not
 * present in this tree, so the `"setting"` arm cannot be evaluated here and is
 * left as a caller-supplied `switchModelsOnFlagEnabled` flag defaulting to
 * false.
 */
export function classifyRefusalFallbackSuppression(
  input: RefusalFallbackDecisionInput,
  switchModelsOnFlagEnabled = false,
):
  | 'silent_ab'
  | 'subagent'
  | 'no_dialog_host'
  | 'setting'
  | 'no_consumer_capability'
  | undefined {
  if (input.silentAbArm) {
    return 'silent_ab'
  }
  if (!input.isMainThread) {
    return 'subagent'
  }
  if (input.requestDialog === undefined) {
    return 'no_dialog_host'
  }
  if (switchModelsOnFlagEnabled) {
    return 'setting'
  }
  if (input.consumerLacksDialogCapability) {
    return 'no_consumer_capability'
  }
  return undefined
}

/**
 * Whether the refusal falls back silently (no dialog) — the classic
 * refusal-error behavior (bundle `yxK`): main thread, no dialog host (or the
 * consumer lacks capability), and the switch-models-on flag is OFF.
 *
 * NOTE (未覆盖): as with {@link classifyRefusalFallbackSuppression}, the
 * `switchModelsOnFlag` setting arm is caller-supplied and defaults to off.
 */
export function shouldSilentlyFallBackOnRefusal(
  input: RefusalFallbackDecisionInput,
  switchModelsOnFlagEnabled = false,
): boolean {
  return (
    input.isMainThread &&
    (input.requestDialog === undefined ||
      input.consumerLacksDialogCapability) &&
    switchModelsOnFlagEnabled === false
  )
}

// --- Refusal_fallback_prompt dialog contract (bundle `ri` = Ww(...)) ---------

/**
 * The dialog kind constant (bundle `ri.kind`). This is the "hook constant" the
 * 170 review refers to: the tree only carried the dialog-kind string for this
 * feature, not the feature body.
 */
export const REFUSAL_FALLBACK_DIALOG_KIND = 'refusal_fallback_prompt'

/** The payload shape of the `refusal_fallback_prompt` user dialog (bundle `ri.payload`). */
export interface RefusalFallbackDialogPayload {
  originalModel: string
  fallbackModel: string
  /** `stop_details.category`, when present. */
  apiRefusalCategory?: string | null
  /** Guidance text (see {@link getRefusalFallbackGuidanceText}). */
  guidanceText?: string
  /**
   * Wire uuids of the already-streamed messages this refusal concerns. The
   * consumer evicts them on RESOLUTION (its own response — any choice — or
   * control_cancel_request retirement), never on receipt; a turn torn down
   * mid-dialog keeps the partials. Eviction is idempotent.
   */
  retractedMessageUuids?: string[]
}

/** The result the consumer returns for the dialog (bundle `ri.result`). */
export type RefusalFallbackDialogResult =
  | 'retry_fallback'
  | 'edit_prompt'
  | 'cancelled'

/** Default dialog outcome when the consumer does not answer (bundle `ri.default`). */
export const REFUSAL_FALLBACK_DIALOG_DEFAULT: RefusalFallbackDialogResult =
  'cancelled'

// --- Credit mint (bundle: tengu_fallback_credit_minted) -----------------------

/**
 * Logs the `tengu_fallback_credit_minted` telemetry event — emitted from the
 * streaming loop when a refusal `message_delta` carries a
 * `fallback_credit_token` in `stop_details` and the session has not yet minted
 * a credit this turn. Field set is verbatim from the 2.1.170 bundle.
 *
 * @param requestId       the current API request id (`MH`)
 * @param model           the original model that refused (`f.model`)
 * @param fallbackTargetModel the fallback target model, or undefined
 * @param tokenLength     length of the minted `fallback_credit_token`
 * @param usage           the merged usage at the mint moment
 * @param querySource     the query source
 * @param queryTracking   optional chain id / depth
 */
export function logFallbackCreditMinted(params: {
  requestId: string | null | undefined
  model: string | null | undefined
  fallbackTargetModel: string | null | undefined
  tokenLength: number
  usage: FallbackCreditUsage
  querySource: string
  queryTracking?: { chainId: string; depth: number }
}): void {
  const {
    requestId,
    model,
    fallbackTargetModel,
    tokenLength,
    usage,
    querySource,
    queryTracking,
  } = params
  logEvent('tengu_fallback_credit_minted', {
    request_id: sanitizeRequestIdForTelemetry(requestId),
    model: sanitizeModelForTelemetry(model),
    fallback_target_model: sanitizeModelForTelemetry(fallbackTargetModel),
    token_length: tokenLength,
    query_source: sanitizeForTelemetry(querySource),
    ...fallbackCreditUsageTelemetry(usage),
    ...(queryTracking && {
      query_chain_id: sanitizeRequestIdForTelemetry(queryTracking.chainId),
      query_depth: queryTracking.depth,
    }),
  })
}

// --- Credit forfeit (bundle: tengu_fallback_credit_forfeited) -----------------

/**
 * The forfeit reason, verbatim from the bundle: the dialog outcome maps to the
 * telemetry reason `"cancelled"` when the outcome is `"cancelled"`, otherwise
 * `"dialog_declined"` (covers `edit_prompt` and any non-retry outcome).
 */
export function forfeitReasonForOutcome(
  outcome: RefusalFallbackDialogResult | 'cancelled' | 'retry_fallback',
): 'cancelled' | 'dialog_declined' {
  return outcome === 'cancelled' ? 'cancelled' : 'dialog_declined'
}

/**
 * Logs the `tengu_fallback_credit_forfeited` telemetry event — emitted in the
 * query loop when the user does NOT retry on the fallback model (i.e. the
 * dialog outcome is anything other than `retry_fallback`), for the turn that
 * minted a credit. Field set verbatim: reason, mint_request_id, mint_model.
 *
 * NOTE (未覆盖 wiring): this emitter is ported, but its call-site (the
 * query-loop `fallback_request` / `requestDialog` handler) is absent from the
 * 2.1.170 tree, so it is not wired here.
 */
export function logFallbackCreditForfeited(params: {
  /** The dialog outcome that triggered the forfeit. */
  reason: RefusalFallbackDialogResult | 'cancelled'
  /** The request id the credit was minted for (`o$.requestId`). */
  mintRequestId: string | null | undefined
  /** The model the credit was minted under (bundle `pH` at forfeit time). */
  mintModel: string | null | undefined
}): void {
  const { reason, mintRequestId, mintModel } = params
  logEvent('tengu_fallback_credit_forfeited', {
    reason: sanitizeForTelemetry(forfeitReasonForOutcome(reason)),
    mint_request_id: sanitizeRequestIdForTelemetry(mintRequestId),
    mint_model: sanitizeModelForTelemetry(mintModel),
  })
}

// --- Credit outcome (bundle: tengu_fallback_credit_outcome / eH) --------------

/**
 * The outcome strings the bundle's `eH` closure is invoked with. The three that
 * map onto tree code paths are `stream_completed`, `aborted`, and
 * `attempt_errored`; `credit_beta_header` (credit-strip) and
 * `unattributed_400_dropped` are part of the absent server-refusal-fallback
 * machinery (未覆盖).
 */
export type FallbackCreditOutcome =
  | 'stream_completed'
  | 'aborted'
  | 'attempt_errored'
  | 'credit_beta_header'
  | 'unattributed_400_dropped'

/**
 * Creates the once-settled credit-outcome closure (bundle `eH`).
 *
 * The bundle closure is:
 *   eH = (outcome, requestId, usage) => {
 *     if (!pH || lH) return          // not minted-yet, or already settled
 *     lH = true
 *     d("tengu_fallback_credit_outcome", { outcome: _$(outcome),
 *       mint_request_id: Za(f.fallbackCreditMintRequestId),
 *       mint_model: F_H(f.fallbackCreditMintModel), request_id: Za(requestId),
 *       client_request_id: Za(ZH), model: F_H(f.model), query_source: BkH(f.querySource),
 *       ...(usage && { <usage fields> }) })
 *   }
 *
 * The guard `!pH || lH` means: only settle if a credit is actually in play
 * (`pH` — the credit was minted/armed this turn) AND not already settled
 * (`lH`). `settle()` returns `true` the first time it settles, `false`
 * otherwise, so callers can branch on whether the outcome was recorded.
 *
 * @param mintArmed       whether a fallback credit is in play this turn
 *                        (the bundle `pH` flag). In the streaming port this is
 *                        the "a credit was minted" flag.
 * @param mintRequestId   `f.fallbackCreditMintRequestId`
 * @param mintModel       `f.fallbackCreditMintModel`
 * @param model           `f.model` (the original model)
 * @param querySource     `f.querySource`
 * @param clientRequestId the client-side request id (bundle `ZH`)
 */
export function createRefusalFallbackCreditSettler(params: {
  mintArmed: boolean
  mintRequestId: string | null | undefined
  mintModel: string | null | undefined
  model: string | null | undefined
  querySource: string
  clientRequestId?: string | null
}): (
  outcome: FallbackCreditOutcome,
  requestId: string | null | undefined,
  usage: FallbackCreditUsage | null,
) => boolean {
  const {
    mintArmed,
    mintRequestId,
    mintModel,
    model,
    querySource,
    clientRequestId,
  } = params
  let settled = false
  return (outcome, requestId, usage) => {
    if (!mintArmed || settled) {
      return false
    }
    settled = true
    logEvent('tengu_fallback_credit_outcome', {
      outcome: sanitizeForTelemetry(outcome),
      mint_request_id: sanitizeRequestIdForTelemetry(mintRequestId),
      mint_model: sanitizeModelForTelemetry(mintModel),
      request_id: sanitizeRequestIdForTelemetry(requestId),
      client_request_id: sanitizeRequestIdForTelemetry(clientRequestId),
      model: sanitizeModelForTelemetry(model),
      query_source: sanitizeForTelemetry(querySource),
      ...(usage !== null && fallbackCreditUsageTelemetry(usage)),
    })
    return true
  }
}
