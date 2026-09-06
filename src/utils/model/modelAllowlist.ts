import {
  getFatalAdminPolicyLoadErrors,
  getPolicySettingsOrigin,
  getSettingsForSource,
  getSettings_DEPRECATED,
  hasSurvivingAdminPolicySource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { logForDebugging } from '../debug.js'
import { parseUserSpecifiedModel, resolveModelAliasEnvFree } from './model.js'

export const MODEL_ALIASES_AND_VARIANTS = [
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'fable[1m]',
  'opusplan',
] as const

export const MODEL_FAMILIES = ['sonnet', 'opus', 'haiku', 'fable'] as const

/** Official 2.1.175 `xh`. */
export function isModelAliasOrVariant(model: string): boolean {
  return (MODEL_ALIASES_AND_VARIANTS as readonly string[]).includes(model)
}

/** Official 2.1.175 `hyH`. */
export function isModelFamily(model: string): boolean {
  return (MODEL_FAMILIES as readonly string[]).includes(model)
}

/** Official 2.1.172 `tW` / 2.1.175 `$1` — strip one trailing `[1m]`. */
export function stripTrailing1mSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, '')
}

/** Official 2.1.175 `ekK`. Check word boundary match. */
function wordMatches(haystack: string, needle: string): boolean {
  for (
    let idx = haystack.indexOf(needle);
    idx !== -1;
    idx = haystack.indexOf(needle, idx + 1)
  ) {
    const startBoundary = idx === 0 || !/[a-z0-9]/i.test(haystack[idx - 1]!)
    const end = idx + needle.length
    const endBoundary =
      end === haystack.length || !/[a-z0-9]/i.test(haystack[end]!)
    if (startBoundary && endBoundary) {
      return true
    }
  }
  return false
}

/** Official 2.1.175 `SD_`. */
function modelBelongsToFamily(
  model: string,
  family: string,
  envFree?: boolean,
): boolean {
  if (isModelAliasOrVariant(model)) {
    const resolved = envFree
      ? resolveModelAliasEnvFree(model)
      : parseUserSpecifiedModel(model).toLowerCase()
    return resolved !== null && wordMatches(resolved, family)
  }
  return wordMatches(model, family)
}

/** Official 2.1.175 `HNK`. */
function prefixMatchesModel(modelName: string, prefix: string): boolean {
  if (!modelName.startsWith(prefix)) {
    return false
  }
  return modelName.length === prefix.length || modelName[prefix.length] === '-'
}

/** Official 2.1.175 `RD_`. */
function modelMatchesVersionPrefix(model: string, entry: string): boolean {
  const resolved = isModelAliasOrVariant(model)
    ? parseUserSpecifiedModel(model).toLowerCase()
    : model
  if (prefixMatchesModel(resolved, entry)) {
    return true
  }
  if (
    !entry.startsWith('claude-') &&
    prefixMatchesModel(resolved, `claude-${entry}`)
  ) {
    return true
  }
  return false
}

/** Official 2.1.175 `$NK`. */
function familyHasSpecificEntries(
  family: string,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    if (isModelFamily(entry)) {
      continue
    }
    const idx = entry.indexOf(family)
    if (idx === -1) {
      continue
    }
    const after = idx + family.length
    if (after === entry.length || entry[after] === '-') {
      return true
    }
  }
  return false
}

/** Official 2.1.175 `qNK`. Reverse lookup in modelOverrides map. */
function reverseModelOverridesLookup(
  model: string,
  overridesMap: Record<string, string>,
): string {
  const stripped = stripTrailing1mSuffix(model)
  for (const [key, val] of Object.entries(overridesMap)) {
    if (stripTrailing1mSuffix(val) === stripped) {
      return key
    }
  }
  return model
}

/** Official 2.1.175 `KnH`. Reverse lookup in settings modelOverrides. */
function resolveOverriddenModelReverse(model: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getSettings_DEPRECATED()?.modelOverrides
  } catch {
    return model
  }
  if (!overrides) return model
  for (const [key, val] of Object.entries(overrides)) {
    if (val === model) return key
  }
  return model
}

/** Official 2.1.175 `KNK`. */
function isEnvFreeAliasMatch(
  model: string,
  options?: {
    allowlist?: string[]
    overridesMap?: Record<string, string>
    ignoreModelOverrides?: boolean
    envFreeAliasResolution?: boolean
  },
): boolean {
  const parsed = stripTrailing1mSuffix(
    parseUserSpecifiedModel(model).trim().toLowerCase(),
  )
  const envFree = resolveModelAliasEnvFree(model)
  if (envFree !== null && stripTrailing1mSuffix(envFree) === parsed) {
    return true
  }
  if (isModelAliasOrVariant(parsed)) {
    return false
  }
  return isModelAllowed(parsed, {
    ...options,
    envFreeAliasResolution: true,
  })
}

const enforcementWarnDedup = new Set<string>()

/** Official 2.1.175 `uD_`. Clear enforcement warning dedup cache. */
export function resetEnforcementWarnDedupForTests(): void {
  enforcementWarnDedup.clear()
}

export type PolicyEnforcementState =
  | { state: 'refused' }
  | { state: 'inactive'; cascadeTrusted: boolean }
  | {
      state: 'active'
      allowlist: string[]
      overridesMap: Record<string, string>
    }

/**
 * Official 2.1.175 `ANK` — evaluates surviving admin policy source and
 * returns whether enforcement is active, inactive, or refused (due to fatal errors).
 */
export function getPolicyEnforcementState(): PolicyEnforcementState {
  try {
    const fatalErrors = getFatalAdminPolicyLoadErrors()
    const policy = getSettingsForSource('policySettings')
    const warn = (active: boolean) => {
      if (!policy || fatalErrors.length === 0) return
      const msg = active
        ? 'enforceAvailableModels: an admin policy source failed to load; enforcing the surviving admin tier (the failed source may carry a different policy — fix it to restore full coverage)'
        : 'enforceAvailableModels: an admin policy source failed to load and the surviving admin tier carries no model policy — model enforcement is OFF; the failed source may have carried it'
      if (!enforcementWarnDedup.has(msg)) {
        enforcementWarnDedup.add(msg)
        logForDebugging(msg, { level: 'warn' })
      }
    }
    if (fatalErrors.length > 0 && !hasSurvivingAdminPolicySource()) {
      const msg =
        'enforceAvailableModels: a policy source exists but failed to load; refusing cascade-trust mode (model enforcement from user/project settings is disabled until the policy source is fixed)'
      if (!enforcementWarnDedup.has(msg)) {
        enforcementWarnDedup.add(msg)
        logForDebugging(msg, { level: 'warn' })
      }
      return { state: 'refused' }
    }
    if (!policy) {
      return { state: 'inactive', cascadeTrusted: true }
    }
    const { availableModels, enforceAvailableModels, modelOverrides } = policy
    if (
      fatalErrors.length === 0 &&
      availableModels === undefined &&
      enforceAvailableModels === undefined &&
      modelOverrides === undefined &&
      getPolicySettingsOrigin() === 'hkcu'
    ) {
      return { state: 'inactive', cascadeTrusted: true }
    }
    if (enforceAvailableModels && availableModels === undefined) {
      const msg =
        'enforceAvailableModels: the policy view sets the enforce flag but not availableModels; enforcement is disabled (the flag requires a policy-owned allowlist)'
      if (!enforcementWarnDedup.has(msg)) {
        enforcementWarnDedup.add(msg)
        logForDebugging(msg, { level: 'warn' })
      }
      warn(false)
      return { state: 'inactive', cascadeTrusted: false }
    }
    if (
      enforceAvailableModels !== true ||
      availableModels === undefined ||
      availableModels.length === 0
    ) {
      warn(false)
      return { state: 'inactive', cascadeTrusted: false }
    }
    warn(true)
    return {
      state: 'active',
      allowlist: availableModels,
      overridesMap: modelOverrides ?? {},
    }
  } catch (err) {
    const msg = `enforceAvailableModels: policy-tier settings read failed; refusing cascade-trust mode: ${err instanceof Error ? err.message : String(err)}`
    if (!enforcementWarnDedup.has(msg)) {
      enforcementWarnDedup.add(msg)
      logForDebugging(msg, { level: 'warn' })
    }
    return { state: 'refused' }
  }
}

/**
 * Official 2.1.175 `eC` — check allowlist under active policy enforcement.
 * Returns `false` if refused, `null` if inactive, or boolean check if active.
 */
export function isModelAllowedUnderActiveEnforcement(
  model: string,
): boolean | null {
  const enforcement = getPolicyEnforcementState()
  if (enforcement.state === 'refused') return false
  if (enforcement.state === 'inactive') return null
  return isModelAllowed(model, {
    allowlist: enforcement.allowlist,
    overridesMap: enforcement.overridesMap,
    envFreeAliasResolution: true,
  })
}

/**
 * Official 2.1.175 `o9` — check if a model is allowed by availableModels allowlist.
 */
export function isModelAllowed(
  model: string,
  options?: {
    allowlist?: string[]
    overridesMap?: Record<string, string>
    ignoreModelOverrides?: boolean
    envFreeAliasResolution?: boolean
  },
): boolean {
  if (options?.allowlist === undefined) {
    try {
      if (
        getFatalAdminPolicyLoadErrors().length > 0 &&
        !hasSurvivingAdminPolicySource()
      ) {
        return false
      }
    } catch {
      return false
    }
  }
  const settings = getSettings_DEPRECATED() || {}
  const allowlist = options?.allowlist ?? settings.availableModels
  if (!allowlist) return true
  if (allowlist.length === 0) return false

  const normalizedAllowlist = allowlist.map(entry =>
    stripTrailing1mSuffix(entry.trim().toLowerCase()),
  )
  const normalizedInput = stripTrailing1mSuffix(model.trim().toLowerCase())

  if (
    normalizedAllowlist.includes(normalizedInput) &&
    !isModelFamily(normalizedInput)
  ) {
    if (
      options?.envFreeAliasResolution ||
      !isModelAliasOrVariant(normalizedInput) ||
      isEnvFreeAliasMatch(normalizedInput, options)
    ) {
      return true
    }
  }

  let resolvedInput: string
  if (options?.overridesMap !== undefined) {
    resolvedInput = reverseModelOverridesLookup(model, options.overridesMap)
  } else if (options?.ignoreModelOverrides) {
    resolvedInput = model
  } else {
    let policySettings: SettingsJson | null
    try {
      policySettings = getSettingsForSource('policySettings')
    } catch {
      return false
    }
    resolvedInput =
      policySettings?.availableModels !== undefined
        ? reverseModelOverridesLookup(
            model,
            policySettings.modelOverrides ?? {},
          )
        : resolveOverriddenModelReverse(model)
  }

  const normalizedResolved = stripTrailing1mSuffix(
    resolvedInput.trim().toLowerCase(),
  )

  if (normalizedAllowlist.includes(normalizedResolved)) {
    if (
      !isModelFamily(normalizedResolved) ||
      !familyHasSpecificEntries(normalizedResolved, normalizedAllowlist)
    ) {
      if (
        options?.envFreeAliasResolution ||
        normalizedResolved !== normalizedInput ||
        !isModelAliasOrVariant(normalizedResolved) ||
        isEnvFreeAliasMatch(normalizedResolved, options)
      ) {
        return true
      }
    }
  }

  for (const entry of normalizedAllowlist) {
    if (
      isModelFamily(entry) &&
      !familyHasSpecificEntries(entry, normalizedAllowlist) &&
      modelBelongsToFamily(
        normalizedResolved,
        entry,
        options?.envFreeAliasResolution,
      )
    ) {
      return true
    }
  }

  if (isModelAliasOrVariant(normalizedResolved)) {
    const resolvedName = parseUserSpecifiedModel(normalizedResolved).toLowerCase()
    if (normalizedAllowlist.includes(resolvedName)) {
      return true
    }
  }

  for (const entry of normalizedAllowlist) {
    if (!isModelFamily(entry) && isModelAliasOrVariant(entry)) {
      const resolvedEntry = options?.envFreeAliasResolution
        ? resolveModelAliasEnvFree(entry)
        : parseUserSpecifiedModel(entry).toLowerCase()
      if (
        resolvedEntry !== null &&
        stripTrailing1mSuffix(resolvedEntry) === normalizedResolved
      ) {
        return true
      }
    }
  }

  for (const entry of normalizedAllowlist) {
    if (!isModelFamily(entry) && !isModelAliasOrVariant(entry)) {
      if (modelMatchesVersionPrefix(normalizedResolved, entry)) {
        return true
      }
    }
  }

  return false
}
