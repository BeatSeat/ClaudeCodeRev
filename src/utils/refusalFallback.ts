// Official 2.1.160 G13 — `RjK` refusal-fallback prompt classifier.
//
// When the API stream signals a safety-filter refusal with a suggested
// fallback model, the query loop decides HOW to deliver the prompt to the
// user before switching models. This classifier returns the delivery mode
// (or undefined = "no dialog, just switch silently per the setting").
//
// Bundle mapping (cli.js 2.1.160):
//   RjK({requestDialog,isMainThread,silentAbArm})
//     if (H.silentAbArm) return "silent_ab";
//     if (!H.isMainThread) return "subagent";
//     if (H.requestDialog === void 0) return "no_dialog_host";
//     if (S_("switchModelsOnFlag", !0).value) return "setting";
//     return;
//
// The query-loop call-site (the `fallback_request` branch) and the
// `cIH` refusal_fallback_prompt dialog live in the refusal-fallback base
// flow, which is NOT present in the 2.1.160 TypeScript tree (the tree only
// carries the 529 model-fallback, `tengu_model_fallback_triggered`). This
// classifier is the self-contained 160 delta, exported for that wiring.
import { getInitialSettings } from './settings/settings.js'

/** Bundle RjK return literal. */
export type RefusalFallbackPromptMode =
  | 'silent_ab'
  | 'subagent'
  | 'no_dialog_host'
  | 'setting'

export type RefusalFallbackClassifierInput = {
  /**
   * The query-loop dialog host callback. Present only in the interactive
   * main-thread REPL; `undefined` for SDK / non-interactive / subagent hosts.
   */
  requestDialog: unknown
  /** Whether this query runs on the main thread (vs. a subagent). */
  isMainThread: boolean
  /**
   * Bundle `_O$` — `clientDataCache.convolute_arcades === true`: the A/B arm
   * where the refusal-fallback prompt is shown silently (no dialog).
   */
  silentAbArm: boolean
}

/**
 * Bundle `RjK` — classify how a refusal-fallback model switch is delivered.
 * Returns `undefined` when the `switchModelsOnFlag` setting is off (the
 * switch proceeds silently without a prompt).
 */
export function classifyRefusalFallback(
  input: RefusalFallbackClassifierInput,
): RefusalFallbackPromptMode | undefined {
  if (input.silentAbArm) return 'silent_ab'
  if (!input.isMainThread) return 'subagent'
  if (input.requestDialog === undefined) return 'no_dialog_host'
  if (getInitialSettings().switchModelsOnFlag ?? true) return 'setting'
  return undefined
}
