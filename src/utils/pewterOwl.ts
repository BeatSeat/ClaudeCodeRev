/**
 * Pewter-owl experiment gate cluster — official 2.1.159 bundle module `QyK`.
 *
 * STATUS: **默认关实验（default-off experiment），注入与否待裁 (injection is
 * pending adjudication by the main restore flow).** The prior-hop domain
 * reviews judged this `do-not-land` (changelog "no user-facing changes",
 * default-off experiment). This file is ported verbatim from the official
 * 2.1.159 bundle so the tree is complete; whether it ships is a top-level
 * decision, NOT something this port decides.
 *
 * Bundle short-name → this file (all five are in 159's added-product astdiff
 * bucket; 158 had no `s36`/`t36`/`HO6` — the 158 `IH5`/`e36` were unrelated
 * minify-name reuse, not this feature):
 *   - `IH5` -> getPewterOwlModel
 *   - `s36` -> isPewterOwlSubFeatureEnabled
 *   - `t36` -> isPewterOwlHeader  (export)
 *   - `e36` -> isPewterOwlTool    (export)
 *   - `HO6` -> isPewterOwlBrief   (export)
 *
 * Gate order in the bundle is load-bearing and is preserved verbatim:
 *   1. CLAUDE_CODE_PEWTER_OWL defined-falsy  -> OFF  (P4 in bundle)
 *   2. CLAUDE_CODE_PEWTER_OWL truthy         -> ON   (CH in bundle)
 *   3. non-interactive session               -> OFF  (R6 in bundle)
 *   4. a pinned model is set AND the current
 *      model's canonical name does not include it -> OFF
 *   5. GB `tengu_<subKey>` (default false) OR clientDataCache[subKey] === true
 */
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getGlobalConfig } from './config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import {
  getCanonicalName,
  getMainLoopModel,
} from './model/model.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'

/**
 * Bundle `IH5`. Resolve the Pewter-owl pinned model.
 * `clientDataCache.pewter_owl_model` wins when it is a non-empty string;
 * otherwise fall back to GB `tengu_pewter_owl_model` (empty-string default).
 */
export function getPewterOwlModel(): string {
  const pinned = getGlobalConfig().clientDataCache?.pewter_owl_model
  if (typeof pinned === 'string' && pinned !== '') {
    return pinned
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_pewter_owl_model', '')
}

/**
 * Bundle `s36(H)`. Shared Pewter-owl gate for a sub-feature key. Gate order is
 * verbatim from the 159 bundle (see module header). `subKey` is one of
 * `pewter_owl_header` / `pewter_owl_tool` / `pewter_owl_brief`.
 */
export function isPewterOwlSubFeatureEnabled(subKey: string): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_PEWTER_OWL)) {
    return false
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_PEWTER_OWL)) {
    return true
  }
  if (getIsNonInteractiveSession()) {
    return false
  }
  const pinnedModel = getPewterOwlModel()
  if (
    pinnedModel !== '' &&
    !getCanonicalName(getMainLoopModel()).includes(pinnedModel)
  ) {
    return false
  }
  return (
    getFeatureValue_CACHED_MAY_BE_STALE(`tengu_${subKey}`, false) ||
    getGlobalConfig().clientDataCache?.[subKey] === true
  )
}

/** Bundle `t36` — exported as `isPewterOwlHeader`. */
export function isPewterOwlHeader(): boolean {
  return isPewterOwlSubFeatureEnabled('pewter_owl_header')
}

/** Bundle `e36` — exported as `isPewterOwlTool`. */
export function isPewterOwlTool(): boolean {
  return isPewterOwlSubFeatureEnabled('pewter_owl_tool')
}

/** Bundle `HO6` — exported as `isPewterOwlBrief`. */
export function isPewterOwlBrief(): boolean {
  return isPewterOwlSubFeatureEnabled('pewter_owl_brief')
}
