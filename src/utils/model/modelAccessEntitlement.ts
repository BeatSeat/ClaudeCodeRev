/**
 * Official 2.1.187 model_access entitlement deny-list (bundle `Y1e` / `Ife` / `Q2u` / `oLr`).
 *
 * Bootstrap persists `model_access` as `modelAccessCache`. Models with
 * `entitled: false` are denied on hard model-switch paths.
 */

import { getGlobalConfig } from '../config.js'
import { getAPIProvider } from './providers.js'
import {
  isModelAliasOrVariant,
  stripTrailing1mSuffix,
} from './modelAllowlist.js'
import { getCanonicalName, parseUserSpecifiedModel } from './model.js'

export type ModelAccessEntry = {
  apiName: string
  entitled: boolean
}

/** Official 2.1.187 `oLr` — validated entries from global config cache. */
export function getModelAccessCache(): ModelAccessEntry[] {
  const raw = getGlobalConfig().modelAccessCache
  return (Array.isArray(raw) ? raw : []).filter(
    (entry): entry is ModelAccessEntry =>
      entry != null &&
      typeof entry === 'object' &&
      typeof (entry as ModelAccessEntry).apiName === 'string' &&
      typeof (entry as ModelAccessEntry).entitled === 'boolean',
  )
}

/** Official 2.1.187 `J2u` — canonicalize apiName for the deny set. */
function canonicalizeAccessApiName(apiName: string): string {
  return getCanonicalName(stripTrailing1mSuffix(apiName.trim().toLowerCase()))
}

/** Official 2.1.187 `Q2u` — set of canonical names that are not entitled. */
export function getUnentitledModelCanonicalNames(
  entries: ModelAccessEntry[] | undefined = getModelAccessCache(),
): Set<string> {
  const denied = new Set<string>()
  for (const entry of entries ?? []) {
    if (!entry.entitled) {
      denied.add(canonicalizeAccessApiName(entry.apiName))
    }
  }
  return denied
}

/**
 * Official 2.1.187 `Ife` — entitlement deny-set for 1P / gateway only.
 * Other providers return an empty set (no entitlement enforcement).
 */
export function getEntitlementDenySet(): Set<string> {
  const provider = getAPIProvider() as string
  if (provider !== 'firstParty' && provider !== 'gateway') {
    return new Set()
  }
  return getUnentitledModelCanonicalNames()
}

/**
 * Official 2.1.187 `Y1e` — true when the model is on the entitlement deny-list.
 * Empty deny-set → never denied.
 */
export function isModelDeniedByEntitlement(
  model: string,
  denySet: Set<string> = getEntitlementDenySet(),
): boolean {
  if (denySet.size === 0) return false
  const normalized = stripTrailing1mSuffix(model.trim().toLowerCase())
  const resolved = isModelAliasOrVariant(normalized)
    ? parseUserSpecifiedModel(normalized)
    : normalized
  return denySet.has(getCanonicalName(resolved))
}
