// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isEnterpriseUsageBasedSubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getCachedInferenceProfileBackingModel } from './bedrock.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettings_DEPRECATED,
  getSourceForSetting,
} from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getAPIProvider,
  getAPIProviderForModel,
  isFirstPartyApiFamily,
  isFirstPartyAnthropicBaseUrl,
} from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import {
  getPolicyEnforcementState,
  isModelAliasOrVariant,
  isModelAllowed,
  isModelAllowedUnderActiveEnforcement,
  isModelFamily,
  stripTrailing1mSuffix,
} from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'
import { logForDebugging } from '../debug.js'
import { getGlobalConfig } from '../config.js'
import { isFastModeEnabled } from '../fastMode.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

export function getSmallFastModel(): ModelName {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46 ||
    model === getModelStrings().opus47 ||
    model === getModelStrings().opus48
  )
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Startup-header suffix when the active model is a project or managed pin.
 * Official 2.1.117 aN8 — empty when --model / ANTHROPIC_MODEL / user-or-local win.
 */
export function getModelPinSourceAnnotation(): string {
  if (getMainLoopModelOverride() !== undefined) {
    return ''
  }
  if (process.env.ANTHROPIC_MODEL) {
    return ''
  }
  switch (getSourceForSetting('model')) {
    case 'projectSettings':
      return ` (from ${getRelativeSettingsFilePathForSource('projectSettings')})`
    case 'policySettings':
      return ' (from managed settings)'
    default:
      return ''
  }
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

/** Official 2.1.170 `Pw6` — re-entrancy guard for `T0K` / `availableModels: ["best"]`. */
let resolvingBestModel = false

export function getBestModel(): ModelName {
  // Official 2.1.170 `T0K`: Fable when available and allowlisted, else Opus.
  if (isFableAvailable()) {
    const fable = getDefaultFableModel()
    if (resolvingBestModel) {
      return fable
    }
    resolvingBestModel = true
    try {
      if (isModelAllowed(fable)) {
        return fable
      }
    } finally {
      resolvingBestModel = false
    }
  }
  return getDefaultOpusModel()
}

/** Official 2.1.173 `Ra` (172 `xNH`; 172 fable paths used stub `dVK` = false). */
function isFirstPartyAnthropicApi(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/** Official 2.1.173 `yh` (172 `tS`). Native 1M — no `[1m]` suffix needed. */
function modelHasNative1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  if (
    canonical !== 'claude-fable-5' &&
    canonical !== 'claude-mythos-5' &&
    canonical !== 'claude-opus-4-7' &&
    canonical !== 'claude-opus-4-8'
  ) {
    return false
  }
  const provider = getAPIProviderForModel(model)
  return (
    (provider === 'firstParty' && isFirstPartyAnthropicBaseUrl()) ||
    provider === 'anthropicAws' ||
    provider === 'mantle'
  )
}

/** Official 2.1.173 `lq8` (172 `dq8`). */
function stripAll1mSuffixes(model: string): string {
  return model.replace(/\[1m\]/gi, '')
}

/** Official 2.1.175 `nJ$`. */
export const strip1mTag = stripAll1mSuffixes

const GEO_PREFIXES = ['us', 'eu', 'apac', 'jp', 'au', 'us-gov', 'global'] as const
const MODEL_PREFIX_REGEX = new RegExp(
  `^((${GEO_PREFIXES.join('|')})\\.)?(anthropic\\.|claude-)`,
)
const SHORT_VERSION_REGEX = /^[a-z]+-\d/

/** Official 2.1.175 `_NK`. */
export function isRecognizedModelIdentifier(model: string): boolean {
  const lower = model.toLowerCase()
  if (MODEL_PREFIX_REGEX.test(lower)) return true
  if (lower.startsWith('arn:aws:bedrock:')) return true
  if (getAPIProvider() === 'foundry') return true
  return false
}

/** Official 2.1.175 `uD6`. */
export function isModelIneligibleFor1mContext(model: string): boolean {
  return (
    model.includes('claude-3-') ||
    model === 'claude-opus-4-0' ||
    model === 'claude-opus-4-1' ||
    model === 'claude-opus-4-5' ||
    model === 'claude-haiku-4-5'
  )
}

/** Official 2.1.175 `sDH`. */
export function isModel1mEligible(model: string): boolean {
  const stripped = stripTrailing1mSuffix(model).trim().toLowerCase()
  if (!stripped.startsWith('claude-')) return true
  return (
    !isModelIneligibleFor1mContext(firstPartyNameToCanonical(stripped)) &&
    (stripped.includes('opus') ? isOpus1mMergeEnabled() : true)
  )
}

/** Official 2.1.173 `f5H` (172 `_5H` / `_D$`). */
export function getDefaultFableModel(): ModelName {
  const model =
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL || getModelStrings().fable5
  return isFirstPartyAnthropicApi() ? stripAll1mSuffixes(model) : model
}

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

export function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/** Official 2.1.175 `eDH`. */
export function getDisabledModelOptions(): Array<{
  value: string | null
  label: string
  description: string
  disabled?: boolean
}> {
  const cache = getGlobalConfig().additionalModelOptionsCache
  return (Array.isArray(cache) ? cache : []).filter(
    (item: any) =>
      item != null &&
      typeof item === 'object' &&
      (typeof item.value === 'string' || item.value === null) &&
      typeof item.label === 'string' &&
      typeof item.description === 'string',
  )
}

/** Official 2.1.170 `AlH`. */
export function isFableModel(model: ModelName): boolean {
  return firstPartyNameToCanonical(model) === 'claude-fable-5'
}

/** Official 2.1.170 `HD$`. */
export function isMythosModel(model: ModelName): boolean {
  return firstPartyNameToCanonical(model) === 'claude-mythos-5'
}

/** Official 2.1.175 `CnH`. */
export function isNonCustomMythosModel(model: ModelName): boolean {
  return firstPartyNameToCanonical(model) === 'claude-mythos-5'
}

/** Official 2.1.175 `sK8`. */
export function isMythosAvailable(): boolean {
  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) {
    return false
  }
  return (getDisabledModelOptions() ?? []).some(
    opt =>
      opt.disabled !== true &&
      typeof opt.value === 'string' &&
      isMythosModel(opt.value),
  )
}

/** Official 2.1.170 `MkH`. */
export function modelIdIncludesFable(model: string): boolean {
  return model.includes('claude-fable-5')
}

/** Official 2.1.170 `TlH`. */
export function modelIdStartsWithFableFamily(model: string): boolean {
  return firstPartyNameToCanonical(model).startsWith('claude-fable-')
}

/** Official 2.1.175 `k6H` (was `N_H` in 2.1.170). */
export function isFableAvailable(): boolean {
  if (
    getAPIProvider() === 'firstParty' &&
    isFirstPartyAnthropicBaseUrl() &&
    (getDisabledModelOptions() ?? []).some(
      opt =>
        opt.disabled === true &&
        typeof opt.value === 'string' &&
        modelIdIncludesFable(opt.value),
    )
  ) {
    return false
  }
  if (process.env.ANTHROPIC_DEFAULT_FABLE_MODEL) {
    return true
  }
  const provider = getAPIProvider()
  if (provider !== 'firstParty' && provider !== 'gateway') {
    return false
  }
  if (provider === 'firstParty' && !isFirstPartyAnthropicBaseUrl()) {
    return false
  }
  return (getDisabledModelOptions() ?? []).some(
    opt =>
      opt.disabled !== true &&
      typeof opt.value === 'string' &&
      modelIdIncludesFable(opt.value),
  )
}

/** Official 2.1.175 `tDH`. */
export function getModelUnavailabilityReason(
  model: string,
  options?: { ignoreModelOverrides?: boolean },
):
  | { reason: 'disabled'; description: string }
  | { reason: 'absent'; displayName: string }
  | null {
  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) {
    return null
  }
  const trimmedLower = model.toLowerCase().trim()
  const resolved = isModelAliasOrVariant(trimmedLower)
    ? parseUserSpecifiedModel(model)
    : model
  const canonicalizer = options?.ignoreModelOverrides
    ? (target: string) =>
        normalizeModelStringForAPI(
          stripTrailing1mSuffix(target.toLowerCase()).trim(),
        )
    : (target: string) =>
        getCanonicalName(stripTrailing1mSuffix(target.toLowerCase()).trim())
  const canonicalModel = canonicalizer(model)
  const canonicalResolved = canonicalizer(resolved)
  const disabledOption = getDisabledModelOptions().find(
    opt =>
      opt.disabled === true &&
      typeof opt.value === 'string' &&
      (canonicalizer(opt.value) === canonicalModel ||
        canonicalizer(opt.value) === canonicalResolved),
  )
  if (disabledOption) {
    return { reason: 'disabled', description: disabledOption.description }
  }
  const resolvedForCheck = options?.ignoreModelOverrides
    ? normalizeModelStringForAPI(resolved)
    : getCanonicalName(resolved)
  if (!isFableAvailable() && resolvedForCheck === 'claude-fable-5') {
    return {
      reason: 'absent',
      displayName: getPublicModelDisplayName(resolved) ?? 'That model',
    }
  }
  if (
    !isMythosAvailable() &&
    (options?.ignoreModelOverrides
      ? resolvedForCheck === 'claude-mythos-5'
      : isNonCustomMythosModel(resolved))
  ) {
    return {
      reason: 'absent',
      displayName: getPublicModelDisplayName(resolved) ?? 'That model',
    }
  }
  return null
}

export function getDefaultOpusModelEnvFree(
  strings = getModelStrings(),
): ModelName {
  if (getAPIProvider() === 'mantle') {
    return strings.opus47
  }
  if (!isFirstPartyApiFamily()) {
    return strings.opus47
  }
  if (getAPIProvider() !== 'firstParty') {
    return strings.opus47
  }
  return strings.opus48
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
export function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  return getDefaultOpusModelEnvFree()
}

/** Official 2.1.176 `xZK` — newest-first Opus keys for the classifier fallback. */
const CLASSIFIER_OPUS_FALLBACK_KEYS = [
  'opus48',
  'opus47',
  'opus46',
  'opus45',
] as const

/**
 * Official 2.1.176 `ys` — main-loop model equals `ANTHROPIC_DEFAULT_FABLE_MODEL`.
 */
function isCustomDefaultFableModel(model: string): boolean {
  const env = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (!env) return false
  return stripTrailing1mSuffix(model) === stripTrailing1mSuffix(env)
}

/**
 * Official 2.1.176 `GhH` / 2.1.178 `cj` — Fable 5 (canonical or custom
 * default-Fable env). 178 `KQ` is the env arm.
 */
export function isFableClassifierMainModel(model: string): boolean {
  return (
    stripTrailing1mSuffix(getCanonicalName(model)) === 'claude-fable-5' ||
    isCustomDefaultFableModel(model)
  )
}

/** Official 2.1.176 `lX$`. */
function isMythosClassifierMainModel(model: string): boolean {
  return stripTrailing1mSuffix(getCanonicalName(model)) === 'claude-mythos-5'
}

/**
 * Official 2.1.176 `GhH`/`lX$` — z64 uses nX$ when the main loop is Fable or
 * Mythos (auto mode otherwise pins the classifier to a missing Opus 4.8).
 */
export function classifierFallsBackToBestAvailableOpus(
  mainModel: string,
): boolean {
  return (
    isFableClassifierMainModel(mainModel) ||
    isMythosClassifierMainModel(mainModel)
  )
}

/**
 * Official 2.1.176 `nX$`. Prefer `ANTHROPIC_DEFAULT_OPUS_MODEL`; else on
 * firstParty walk `xZK` for the first allowlisted Opus, else `opus48`. If the
 * main model has 1M context and the pick is 1M-eligible, append `[1m]`.
 */
export function getBestAvailableOpusForClassifier(
  mainModel: string,
): ModelName {
  let pick = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  if (pick === undefined) {
    const strings = getModelStrings()
    pick = strings.opus48
    if (getAPIProvider() === 'firstParty') {
      pick =
        CLASSIFIER_OPUS_FALLBACK_KEYS.map(key => strings[key]).find(model =>
          isModelAllowed(model),
        ) ?? strings.opus48
    }
  }
  if (
    (has1mContext(mainModel) || modelHasNative1mContext(mainModel)) &&
    !has1mContext(pick) &&
    !isModelIneligibleFor1mContext(getCanonicalName(pick))
  ) {
    return pick + '[1m]'
  }
  return pick
}

export function getDefaultSonnetModelEnvFree(
  strings = getModelStrings(),
): ModelName {
  if (!isFirstPartyApiFamily()) {
    return strings.sonnet45
  }
  return strings.sonnet46
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
export function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  return getDefaultSonnetModelEnvFree()
}

export function getDefaultHaikuModelEnvFree(
  strings = getModelStrings(),
): ModelName {
  return strings.haiku45
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  return getDefaultHaikuModelEnvFree()
}

export function getDefaultFableModelEnvFree(
  strings = getModelStrings(),
): ModelName {
  const model = strings.fable5
  return is1mContextDisabled() ? strip1mTag(model) : model
}

/** Official 2.1.175 `oK8` / `UJ$`. Resolves alias using pure getModelStrings() without env var overrides. */
export function resolveModelAliasEnvFree(alias: string): string | null {
  const strings = getModelStrings()
  switch (alias) {
    case 'opus':
      return getDefaultOpusModelEnvFree(strings)
    case 'sonnet':
      return getDefaultSonnetModelEnvFree(strings)
    case 'haiku':
      return getDefaultHaikuModelEnvFree(strings)
    case 'fable':
      return getDefaultFableModelEnvFree(strings)
    case 'opusplan':
      return getDefaultSonnetModelEnvFree(strings)
    case 'best':
      return isFableAvailable()
        ? getDefaultFableModelEnvFree(strings)
        : getDefaultOpusModelEnvFree(strings)
    default:
      return null
  }
}

/** Official 2.1.175 `xD_`. */
export function getSteeringVarTable(strings = getModelStrings()): readonly [
  readonly ['haiku', string | undefined, 0, () => ModelName],
  readonly ['sonnet', string | undefined, 1, () => ModelName],
  readonly ['opus', string | undefined, 2, () => ModelName],
] {
  return [
    [
      'haiku',
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      0,
      () => getDefaultHaikuModelEnvFree(strings),
    ],
    [
      'sonnet',
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      1,
      () => getDefaultSonnetModelEnvFree(strings),
    ],
    [
      'opus',
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      2,
      () => getDefaultOpusModelEnvFree(strings),
    ],
  ] as const
}

/** Official 2.1.175 `xnH`. */
export function isModeDependentModelSetting(model: string): boolean {
  return model === 'opusplan' || model === 'haiku'
}

/** Official 2.1.175 `zNK`. */
export function resolvesToDefaultModel(model: string): boolean {
  return (
    stripTrailing1mSuffix(parseUserSpecifiedModel(model)).toLowerCase() ===
    stripTrailing1mSuffix(getDefaultMainLoopModel()).toLowerCase()
  )
}

/** Official 2.1.175 `Ij`. */
export function isExemptDefaultResolvingPick(model: string): boolean {
  const stripped = stripTrailing1mSuffix(model.trim().toLowerCase())
  if (isModeDependentModelSetting(stripped)) return false
  if (stripped === 'best') return false
  return resolvesToDefaultModel(model)
}

/** Official 2.1.175 `bD6`. */
export function isWindowSilentDefaultPick(model: string): boolean {
  if (!isExemptDefaultResolvingPick(model)) return false
  const trimmed = model.trim().toLowerCase()
  return (
    parseUserSpecifiedModel(model).toLowerCase() ===
      getDefaultMainLoopModel().toLowerCase() ||
    (isModelAliasOrVariant(trimmed) &&
      trimmed === stripTrailing1mSuffix(trimmed))
  )
}

/** Official 2.1.175 `CD6`. Computes baseline default model setting and tier family. */
export function getBaselineDefaultModel(): {
  setting: ModelName | ModelAlias
  envFamily: 'opus' | 'sonnet' | null
  concreteBaseline?: string
} {
  if (isClaudeAISubscriber()) {
    if (
      isMaxSubscriber() ||
      isTeamPremiumSubscriber() ||
      isEnterpriseUsageBasedSubscriber()
    ) {
      return {
        setting: isOpus1mMergeEnabled()
          ? ensureSingle1mSuffix(getDefaultOpusModel())
          : getDefaultOpusModel(),
        envFamily: 'opus',
      }
    }
  } else if (isFirstPartyApiFamily()) {
    return {
      setting: isOpus1mMergeEnabled()
        ? ensureSingle1mSuffix(getDefaultOpusModel())
        : getDefaultOpusModel(),
      envFamily: 'opus',
    }
  }
  if (getAPIProvider() === 'mantle') {
    return {
      setting: getModelStrings().opus47,
      envFamily: null,
      concreteBaseline: String(getModelStrings().opus47),
    }
  }
  return {
    setting: getDefaultSonnetModel(),
    envFamily: 'sonnet',
  }
}

const enforcedDefaultDedup = new Set<string>()

/**
 * Official 2.1.175 `tK8` — resolves fallback model when enforceAvailableModels
 * is active/trusted and default model is disallowed.
 */
export function getEnforcedDefaultModel(
  setting: ModelName | ModelAlias,
  envFamily?: 'opus' | 'sonnet' | null,
  concreteBaseline?: string,
): string | null {
  const settings = getSettings_DEPRECATED() || {}
  let availableModels = settings.availableModels
  let enforce = settings.enforceAvailableModels
  let overridesMap: Record<string, string> = {}
  const enforcement = getPolicyEnforcementState()
  if (enforcement.state === 'refused') return null
  const isCascadeTrustedInactive =
    enforcement.state === 'inactive' && enforcement.cascadeTrusted
  if (enforcement.state === 'active') {
    availableModels = enforcement.allowlist
    enforce = true
    overridesMap = enforcement.overridesMap
  } else if (!enforcement.cascadeTrusted) {
    return null
  }
  if (!enforce) return null
  if (
    isCascadeTrustedInactive &&
    Object.keys(overridesMap).length === 0 &&
    settings.modelOverrides
  ) {
    overridesMap = settings.modelOverrides
  }
  if (!availableModels || availableModels.length === 0) return null

  const allowlistOptions = {
    overridesMap,
    envFreeAliasResolution: true,
    allowlist: availableModels,
  }

  const lookupOverride = (model: string): string | undefined => {
    const stripped = firstPartyNameToCanonical(stripTrailing1mSuffix(model))
    for (const [key, value] of Object.entries(overridesMap)) {
      if (
        firstPartyNameToCanonical(stripTrailing1mSuffix(key)) === stripped
      ) {
        return value
      }
    }
    return undefined
  }

  const applyMapping = (
    candidate: string,
    opts?: { isConcreteEntry?: boolean },
  ): string => {
    const strippedCandidate = stripTrailing1mSuffix(candidate)
    if (opts?.isConcreteEntry) return candidate
    let mapped = lookupOverride(strippedCandidate)
    if (!mapped?.trim()) return candidate
    mapped = mapped.trim()
    {
      const normalizedMapped = stripTrailing1mSuffix(mapped)
        .trim()
        .toLowerCase()
      const has1m = has1mContext(mapped)
      const aliasResolved = isModelAliasOrVariant(normalizedMapped)
        ? resolveModelAliasEnvFree(normalizedMapped)
        : null
      if (aliasResolved !== null) {
        mapped = has1m ? ensureSingle1mSuffix(aliasResolved) : aliasResolved
      } else {
        const withPrefix = normalizedMapped.startsWith('claude-')
          ? normalizedMapped
          : `claude-${normalizedMapped}`
        if (isLegacyOpusFirstParty(withPrefix) && isFirstPartyApiFamily()) {
          const defaultOpus = getDefaultOpusModelEnvFree(getModelStrings())
          mapped = has1m ? ensureSingle1mSuffix(defaultOpus) : defaultOpus
        }
      }
    }
    if (
      getModelUnavailabilityReason(stripTrailing1mSuffix(mapped), {
        ignoreModelOverrides: true,
      }) !== null
    ) {
      const warnMsg = `enforceAvailableModels: the managed modelOverrides target "${mapped}" is server-unavailable; using the unmapped candidate`
      if (!enforcedDefaultDedup.has(warnMsg)) {
        enforcedDefaultDedup.add(warnMsg)
        logForDebugging(warnMsg, { level: 'warn' })
      }
      return candidate
    }
    if (strippedCandidate !== candidate) {
      return isModel1mEligible(mapped)
        ? ensureSingle1mSuffix(mapped)
        : stripTrailing1mSuffix(mapped)
    }
    if (has1mContext(mapped) && !isModel1mEligible(mapped)) {
      return stripTrailing1mSuffix(mapped)
    }
    return mapped
  }

  let userSteeringCandidate: string | null = null
  const settingStr = String(setting)
  const normalizedSetting = stripTrailing1mSuffix(
    settingStr.trim().toLowerCase(),
  )
  const settingHas1m = has1mContext(settingStr)
  const settingPrefixed = normalizedSetting.startsWith('claude-')
    ? normalizedSetting
    : `claude-${normalizedSetting}`
  const settingAliasResolved = isLegacyOpusFirstParty(settingPrefixed)
    ? getDefaultOpusModelEnvFree(getModelStrings())
    : resolveModelAliasEnvFree(normalizedSetting)

  if (settingAliasResolved !== null) {
    const candidate =
      normalizedSetting !== settingStr.trim().toLowerCase() &&
      isModel1mEligible(settingAliasResolved)
        ? ensureSingle1mSuffix(settingAliasResolved)
        : stripTrailing1mSuffix(settingAliasResolved)
    const userSpecified = parseUserSpecifiedModel(settingStr)
    if (
      stripTrailing1mSuffix(userSpecified) !==
      stripTrailing1mSuffix(settingAliasResolved)
    ) {
      userSteeringCandidate = candidate
    }
    if (isModelAllowed(candidate, allowlistOptions)) {
      if (
        stripTrailing1mSuffix(userSpecified) !==
        stripTrailing1mSuffix(settingAliasResolved)
      ) {
        if (
          getModelUnavailabilityReason(candidate, {
            ignoreModelOverrides: true,
          }) === null
        ) {
          return applyMapping(candidate)
        }
      } else {
        return null
      }
    }
  } else {
    const strings = getModelStrings()
    const steeringTable = getSteeringVarTable(strings)
    if (envFamily !== undefined) {
      if (envFamily !== null) {
        const row = steeringTable.find(([fam]) => fam === envFamily)
        if (row === undefined) {
          throw new Error(
            `steeringVarTable has no row for tier family "${envFamily}"`,
          )
        }
        const resolver = row[3]
        const resolved = resolver()
        if (
          typeof resolved === 'string' &&
          stripTrailing1mSuffix(resolved).toLowerCase() !== normalizedSetting
        ) {
          const val = resolver()
          userSteeringCandidate =
            settingHas1m && isModel1mEligible(val)
              ? ensureSingle1mSuffix(val)
              : val
        }
      }
      if (
        envFamily === null &&
        concreteBaseline !== undefined &&
        stripTrailing1mSuffix(concreteBaseline).toLowerCase() !==
          normalizedSetting
      ) {
        userSteeringCandidate = concreteBaseline
      }
    } else {
      const matchIndex = (() => {
        for (const [, , index, resolver] of steeringTable) {
          const val = resolver()
          if (
            typeof val === 'string' &&
            stripTrailing1mSuffix(val).toLowerCase() === normalizedSetting
          ) {
            return index
          }
        }
        return null
      })()
      for (const [, envVar, index, resolver] of steeringTable) {
        if (
          envVar === undefined ||
          stripTrailing1mSuffix(envVar.trim().toLowerCase()) !==
            normalizedSetting
        ) {
          continue
        }
        if (matchIndex !== null && matchIndex <= index) continue
        const val = resolver()
        userSteeringCandidate =
          settingHas1m && isModel1mEligible(val)
            ? ensureSingle1mSuffix(val)
            : val
        break
      }
    }
    if (isModelAllowed(settingStr, allowlistOptions)) {
      return null
    }
  }

  const skippedUnavailable: string[] = []
  for (const entry of availableModels) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()
    const stripped = stripTrailing1mSuffix(lower)
    const aliasResolved = resolveModelAliasEnvFree(stripped)
    if (aliasResolved !== null) {
      const candidate =
        lower !== stripped && isModel1mEligible(aliasResolved)
          ? ensureSingle1mSuffix(aliasResolved)
          : aliasResolved
      if (
        isRecognizedModelIdentifier(candidate) &&
        isModelAllowed(candidate, allowlistOptions)
      ) {
        if (
          getModelUnavailabilityReason(candidate, {
            ignoreModelOverrides: true,
          }) === null
        ) {
          return applyMapping(candidate)
        }
        skippedUnavailable.push(trimmed)
      }
      continue
    }

    const prefixed = stripped.startsWith('claude-')
      ? stripped
      : `claude-${stripped}`
    if (isLegacyOpusFirstParty(prefixed) && isFirstPartyApiFamily()) {
      const defaultOpus = getDefaultOpusModelEnvFree(getModelStrings())
      const candidate =
        lower !== stripped && isModel1mEligible(defaultOpus)
          ? ensureSingle1mSuffix(defaultOpus)
          : defaultOpus
      if (
        getModelUnavailabilityReason(candidate, {
          ignoreModelOverrides: true,
        }) === null
      ) {
        return applyMapping(candidate)
      }
      skippedUnavailable.push(trimmed)
      continue
    }

    const isShortVersion =
      getAPIProvider() !== 'foundry' &&
      !lower.startsWith('claude-') &&
      SHORT_VERSION_REGEX.test(lower)
    const isClaudePrefixed =
      isShortVersion ||
      (getAPIProvider() !== 'foundry' && lower.startsWith('claude-'))
    const parsed = parseUserSpecifiedModel(
      isShortVersion ? `claude-${lower}` : isClaudePrefixed ? lower : trimmed,
    )
    const normalizedParsed = stripTrailing1mSuffix(parsed).toLowerCase()
    if (
      isClaudePrefixed &&
      !/[-@]\d{8}$/.test(normalizedParsed) &&
      firstPartyNameToCanonical(normalizedParsed) !== normalizedParsed
    ) {
      continue
    }
    if (!isRecognizedModelIdentifier(parsed)) continue
    const isConcrete =
      !isClaudePrefixed || /[-@]\d{8}$/.test(normalizedParsed)
    if (isModelAllowed(parsed, allowlistOptions)) {
      if (
        getModelUnavailabilityReason(parsed, {
          ignoreModelOverrides: true,
        }) === null
      ) {
        const strippedParsed = stripTrailing1mSuffix(parsed)
        if (strippedParsed !== parsed) {
          return applyMapping(
            isModel1mEligible(parsed) ? parsed : strippedParsed,
            { isConcreteEntry: isConcrete },
          )
        }
        return applyMapping(parsed, { isConcreteEntry: isConcrete })
      }
      skippedUnavailable.push(trimmed)
    }
  }

  const mappedSteering =
    userSteeringCandidate !== null
      ? lookupOverride(userSteeringCandidate)
      : undefined
  const steeringIsAdminMapped =
    mappedSteering !== undefined &&
    stripTrailing1mSuffix(mappedSteering).trim().toLowerCase() ===
      stripTrailing1mSuffix(settingStr).trim().toLowerCase()
  const reasonText =
    userSteeringCandidate !== null
      ? steeringIsAdminMapped
        ? 'tier default is the admin-mapped value — pinning its canonical builtin (the policy mapping re-applies at the exit)'
        : 'user steering detected — pinning the env-free tier builtin (policy-mapped if applicable)'
      : 'keeping the tier default'

  const warnMsg =
    skippedUnavailable.length > 0
      ? `enforceAvailableModels: no availableModels entry survived; ${skippedUnavailable.length} entr${skippedUnavailable.length === 1 ? 'y was' : 'ies were'} allowed but skipped as server-unavailable (${skippedUnavailable.join(', ')}); ${reasonText}`
      : `enforceAvailableModels: no availableModels entry expands to an allowed model; ${reasonText}`

  if (!enforcedDefaultDedup.has(warnMsg)) {
    enforcedDefaultDedup.add(warnMsg)
    logForDebugging(warnMsg, { level: 'warn' })
  }
  return userSteeringCandidate !== null
    ? applyMapping(userSteeringCandidate)
    : null
}

/** Official 2.1.175 `eK8`. Check if default model selection is enforced by policy. */
export function isDefaultModelEnforced(): boolean {
  const baseline = getBaselineDefaultModel()
  return (
    getEnforcedDefaultModel(
      baseline.setting,
      baseline.envFamily,
      baseline.concreteBaseline,
    ) !== null
  )
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  const setting = getUserSpecifiedModelSetting()
  if (
    (setting === 'opusplan' || setting === 'opusplan[1m]') &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    const upgrade =
      setting === 'opusplan[1m]' || isOpus1mMergeEnabled()
        ? ensureSingle1mSuffix(getDefaultOpusModel())
        : getDefaultOpusModel()
    if (
      !(
        isModelAllowedUnderActiveEnforcement(upgrade) ??
        isModelAllowed(upgrade)
      )
    ) {
      const warnMsg =
        'Plan mode: the opusplan upgrade model is not in the availableModels allowlist; planning uses the resting model instead'
      if (!enforcedDefaultDedup.has(warnMsg)) {
        enforcedDefaultDedup.add(warnMsg)
        logForDebugging(warnMsg, { level: 'warn' })
      }
      return parseUserSpecifiedModel(setting)
    }
    return upgrade
  }

  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    const upgrade = getDefaultSonnetModel()
    if (
      !(
        isModelAllowedUnderActiveEnforcement(upgrade) ??
        isModelAllowed(upgrade)
      )
    ) {
      const warnMsg =
        'Plan mode: the haiku plan upgrade model is not in the availableModels allowlist; planning uses the resting model instead'
      if (!enforcedDefaultDedup.has(warnMsg)) {
        enforcedDefaultDedup.add(warnMsg)
        logForDebugging(warnMsg, { level: 'warn' })
      }
      return parseUserSpecifiedModel(getUserSpecifiedModelSetting()!)
    }
    return upgrade
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * Official 2.1.175 `Y0`: delegates to getEnforcedDefaultModel() ?? baseline.setting.
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  const baseline = getBaselineDefaultModel()
  return (
    getEnforcedDefaultModel(
      baseline.setting,
      baseline.envFamily,
      baseline.concreteBaseline,
    ) ?? baseline.setting
  )
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes('claude-fable-5')) {
    return 'claude-fable-5'
  }
  if (name.includes('claude-mythos-5')) {
    return 'claude-mythos-5'
  }
  if (name.includes('claude-opus-4-8')) {
    return 'claude-opus-4-8'
  }
  if (name.includes('claude-opus-4-7')) {
    return 'claude-opus-4-7'
  }
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Official 2.1.122 `F7`: modelOverrides first; else application-inference-profile
  // ARNs resolve via the GetInferenceProfile backing-model cache so Effort /
  // output_config.effort classify the real family.
  const resolved = resolveOverriddenModel(fullModelName)
  if (resolved !== fullModelName) {
    return firstPartyNameToCanonical(resolved)
  }
  if (fullModelName.includes('application-inference-profile')) {
    const backing = getCachedInferenceProfileBackingModel(
      normalizeModelStringForAPI(fullModelName),
    )
    if (backing) {
      return firstPartyNameToCanonical(backing)
    }
  }
  return firstPartyNameToCanonical(resolved)
}

/** Official 2.1.175 `WY`. */
export function isOpusFastModeModel(model?: string): boolean {
  if (!isFastModeEnabled()) return false
  const target = model ?? getDefaultMainLoopModelSetting()
  const lower = parseUserSpecifiedModel(target).toLowerCase()
  return (
    lower.includes('opus-4-6') ||
    lower.includes('opus-4-7') ||
    lower.includes('opus-4-8')
  )
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
/** Official 2.1.175 `H78`. */
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  const baseline = getBaselineDefaultModel()
  const enforced = getEnforcedDefaultModel(
    baseline.setting,
    baseline.envFamily,
    baseline.concreteBaseline,
  )
  if (enforced !== null) {
    return `${getPublicModelDisplayName(normalizeModelStringForAPI(enforced)) ?? renderModelName(enforced)} · Set by your organization`
  }
  if (
    isMaxSubscriber() ||
    isTeamPremiumSubscriber() ||
    isEnterpriseUsageBasedSubscriber()
  ) {
    const opus = getDefaultOpusModel()
    const name =
      getPublicModelDisplayName(normalizeModelStringForAPI(opus)) ?? 'Opus'
    const showPricing = fastMode && isOpusFastModeModel(opus)
    if (isOpus1mMergeEnabled()) {
      return `${name} with 1M context · Best for everyday, complex tasks${showPricing ? getOpus46PricingSuffix(true, opus) : ''}`
    }
    return `${name} · Best for everyday, complex tasks${showPricing ? getOpus46PricingSuffix(true, opus) : ''}`
  }
  return `${getPublicModelDisplayName(normalizeModelStringForAPI(getDefaultSonnetModel())) ?? 'Sonnet'} · Efficient for routine tasks`
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus in plan mode, else Sonnet'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(fastMode: boolean, model?: string): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}
export const getOpusPricingSuffix = getOpus46PricingSuffix

/** Official 2.1.175 `d4$`. */
export function sanitizeModelNameForDisplay(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._:/@[\]-]/g, '')
  if (sanitized.length === 0) return '(unrecognized model name)'
  return sanitized.length > 128 ? `${sanitized.slice(0, 128)}…` : sanitized
}

/** Official 2.1.175 `THH`. */
export function formatModelRestrictedWarning(
  requested: string,
  effective: string,
): string {
  return `Model "${sanitizeModelNameForDisplay(requested)}" is restricted by your organization's settings. Using ${sanitizeModelNameForDisplay(effective)} instead.`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

/** Official 2.1.172 `iD$` — strip every trailing `[1m]` then add one. */
export function ensureSingle1mSuffix(model: string): string {
  return model.replace(/(\[1m\])+$/i, '') + '[1m]'
}

/**
 * Official 2.1.107 nc4 / 2.1.111: when opus-1m merge is on, resolved
 * opus-4-6 / opus-4-7 agent models that lack an explicit [1m] suffix get one.
 */
export function applyOpus1mMergeIfNeeded(model: string): string {
  if (
    isOpus1mMergeEnabled() &&
    !has1mContext(model) &&
    (getCanonicalName(model).includes('opus-4-7') ||
      getCanonicalName(model).includes('opus-4-6'))
  ) {
    return model + '[1m]'
  }
  return model
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  switch (model) {
    case getModelStrings().fable5:
      return 'Fable 5'
    case getModelStrings().fable5 + '[1m]':
      return 'Fable 5 (1M context)'
    case getModelStrings().opus48:
      return 'Opus 4.8'
    case getModelStrings().opus48 + '[1m]':
      return 'Opus 4.8 (1M context)'
    case getModelStrings().opus47:
      return 'Opus 4.7'
    case getModelStrings().opus47 + '[1m]':
      return 'Opus 4.7 (1M context)'
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {ModelName}" for publicly known models, or "Claude ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Claude {ModelName}" for public models, or "Claude ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'fable': {
        // Official 2.1.173 `g7`: append `[1m]` only when the user asked and
        // first-party Anthropic is not already natively 1M (`!Ra() && !Nj(f)`).
        const defaultFable = getDefaultFableModel()
        return (
          defaultFable +
          (has1mTag &&
          !isFirstPartyAnthropicApi() &&
          !has1mContext(defaultFable)
            ? '[1m]'
            : '')
        )
      }
      case 'opusplan':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '') // Sonnet is default, Opus in plan mode
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        // Official 2.1.172 `g7`: opus + [1m] uses `iD$` so a default that
        // already includes the suffix does not double it.
        return has1mTag
          ? ensureSingle1mSuffix(getDefaultOpusModel())
          : getDefaultOpusModel()
      case 'best':
        return getBestModel()
      default:
    }
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Claude.ai) — silently remap to the current Opus default. The 'opus'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    getAPIProvider() === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Official 2.1.173 `g7`: first-party Fable already has 1M context, so a
  // trailing `[1m]` is stripped and not re-added (`K&&Ra()&&_w_(_)&&yh(_)`).
  if (
    has1mTag &&
    isFirstPartyAnthropicApi() &&
    modelString.includes('fable') &&
    modelHasNative1mContext(modelString)
  ) {
    return modelInputTrimmed.replace(/(\[1m\])+$/i, '').trim()
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return ensureSingle1mSuffix(modelInputTrimmed)
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}


/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-fable-5')) {
    return 'Fable 5'
  }
  if (canonical.includes('claude-mythos-5')) {
    return 'Mythos 5'
  }
  if (canonical.includes('claude-opus-4-8')) {
    return has1m ? 'Opus 4.8 (1M context)' : 'Opus 4.8'
  }
  if (canonical.includes('claude-opus-4-7')) {
    return has1m ? 'Opus 4.7 (1M context)' : 'Opus 4.7'
  }
  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
