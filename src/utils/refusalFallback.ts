/**
 * Official 2.1.166 switch-models-on-refusal classifier.
 *
 * When a model response is refused, Claude Code can automatically switch to a
 * fallback model to keep the conversation going, gated by the
 * `switchModelsOnFlag` settings field (default on). This module holds the two
 * pure decision helpers the query loop consults around that flow:
 *
 * - `classifyRefusalFallbackReason` (`f2K`): why a given attempt would NOT get
 *   a refusal-fallback switch/dialog — one of four reasons, or `undefined` when
 *   it would proceed normally.
 * - `isRefusalFallbackSuppressed` (`gf6`): the specific "suppressed" case the
 *   loop logs as `tengu_refusal_fallback_suppressed` (reason
 *   `no_dialog_host_setting_off`) — main thread, no dialog host wired, and the
 *   switch-models-on-refusal setting turned off.
 *
 * BOUNDARY: the surrounding refusal-fallback machinery (the `fallback_request`
 * stream event, the `tengu_loggia_carousel` / `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`
 * feature gate, the fallback-model picker, and the "has specific safety
 * measures…" user-facing message builders) is not present in the 2.1.166 tree,
 * so these helpers are exported for the loop to call once that machinery lands.
 */
import { getEnabledSettingSources } from './settings/constants.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * Inputs to the switch-models-on-refusal reason classifier.
 */
export type RefusalFallbackClassifierInput = {
  /** The silent A/B arm is armed (clientDataCache `convolute_arcades` flag). */
  silentAbArm: boolean
  /** True when this is the main repl thread (vs. a subagent). */
  isMainThread: boolean
  /** The dialog host handle, if any. `undefined` means no dialog host is wired. */
  requestDialog?: unknown
}

/** The four ways a refusal-fallback is declined before it can show. */
export type RefusalFallbackReason =
  | 'silent_ab'
  | 'subagent'
  | 'no_dialog_host'
  | 'setting'

/**
 * Official 2.1.166 `u1("switchModelsOnFlag", !0).value` — read the
 * switch-models-on-refusal settings flag (default `true`).
 *
 * `switchModelsOnFlag` is a settings key (not a `/config` user-intent key), so —
 * unlike the bundle's general `u1` reader — there is no legacy-global-config
 * fallback: walk the enabled settings sources high→low and return the first
 * defined value, else the default `true`.
 */
function isSwitchModelsOnFlagEnabled(): boolean {
  const sources = getEnabledSettingSources()
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]
    if (!source) continue
    const value = getSettingsForSource(source)?.switchModelsOnFlag
    if (value !== undefined) return value
  }
  return true
}

/**
 * Official 2.1.166 `f2K` — classify why a refusal-fallback dialog/switch would
 * be declined for this attempt, or `undefined` when it would proceed.
 */
export function classifyRefusalFallbackReason(
  input: RefusalFallbackClassifierInput,
): RefusalFallbackReason | undefined {
  if (input.silentAbArm) return 'silent_ab'
  if (!input.isMainThread) return 'subagent'
  if (input.requestDialog === undefined) return 'no_dialog_host'
  if (isSwitchModelsOnFlagEnabled()) return 'setting'
  return undefined
}

/**
 * Official 2.1.166 `gf6` — the exact case the query loop logs as
 * `tengu_refusal_fallback_suppressed` (`reason: "no_dialog_host_setting_off"`):
 * main thread, no dialog host wired, and switch-models-on-refusal off.
 */
export function isRefusalFallbackSuppressed(
  input: RefusalFallbackClassifierInput,
): boolean {
  return (
    input.isMainThread &&
    input.requestDialog === undefined &&
    isSwitchModelsOnFlagEnabled() === false
  )
}
