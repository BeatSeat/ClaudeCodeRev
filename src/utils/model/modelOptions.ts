// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  isClaudeAISubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import {
  COST_TIER_3_15,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
} from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isFirstPartyApiFamily,
} from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultFableModel,
  getDefaultMainLoopModelSetting,
  getMainLoopModel,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isFableAvailable,
  isOpus1mMergeEnabled,
  getOpus46PricingSuffix,
  modelIdIncludesFable,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext, is1mContextDisabled } from '../context.js'
import { getGlobalConfig } from '../config.js'
import { getGatewayModelOptions } from './gatewayModels.js'
import { ALL_MODEL_CONFIGS } from './configs.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  if (process.env.USER_TYPE === 'ant') {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const is3P = !isFirstPartyApiFamily()
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

/** Official 2.1.118 Kw6: honor ANTHROPIC_DEFAULT_*_MODEL_NAME/_DESCRIPTION
 *  when not first-party family OR when ANTHROPIC_BASE_URL is a custom gateway. */
function shouldHonorDefaultModelEnvOverrides(): boolean {
  return !isFirstPartyApiFamily() || !isFirstPartyAnthropicBaseUrl()
}

function getCustomSonnetOption(): ModelOption | undefined {
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a 3P user (or custom ANTHROPIC_BASE_URL) has a custom sonnet model string, show it directly
  if (shouldHonorDefaultModelEnvOverrides() && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet46Option(): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: is3P ? getModelStrings().sonnet46 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Efficient for routine tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.6 - efficient for routine tasks. Generally recommended for most coding tasks',
  }
}

function getCustomFableOption(): ModelOption | undefined {
  const customFableModel = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (shouldHonorDefaultModelEnvOverrides() && customFableModel) {
    return {
      value: 'fable',
      label: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME ?? customFableModel,
      description:
        process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ??
        'Custom Fable model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ?? 'Custom Fable model'} (${customFableModel})`,
    }
  }
}

/** Official 2.1.170 `SD6`. */
function getFable5Option(): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: is3P ? getModelStrings().fable5 : 'fable',
    label: 'Fable',
    description:
      'Fable 5 · Most capable for your hardest and longest-running tasks',
    descriptionForModel:
      'Fable 5 - most capable for your hardest and longest-running tasks',
  }
}

/** Official 2.1.170 `PJ$`. */
function isFablePickerValue(value: string): boolean {
  return value === 'fable' || value === 'fable[1m]' || modelIdIncludesFable(value)
}

/** Official 2.1.170 `AxK`. */
function modelFamilyKey(
  model: string,
): 'fable' | 'opus' | 'sonnet' | 'haiku' | null {
  const lower = model.toLowerCase()
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return null
}

/** Official 2.1.170 `hD6`. */
function samePickerOption(a: ModelOption, b: ModelOption): boolean {
  if (a.value === b.value) return true
  return (
    typeof a.value === 'string' &&
    typeof b.value === 'string' &&
    isFablePickerValue(a.value) &&
    isFablePickerValue(b.value)
  )
}

/** Official 2.1.170 `qnH`: Fable rows go after Default + the current family's rows. */
function insertPickerOption(options: ModelOption[], option: ModelOption): void {
  if (!(typeof option.value === 'string' && isFablePickerValue(option.value))) {
    options.push(option)
    return
  }
  const defaultIdx = options.findIndex(o => o.value === null)
  if (defaultIdx === -1) {
    options.splice(0, 0, option)
    return
  }
  const currentFamily = modelFamilyKey(getMainLoopModel())
  let insertAt = defaultIdx + 1
  if (currentFamily !== null) {
    while (insertAt < options.length) {
      const v = options[insertAt]?.value
      if (typeof v === 'string' && modelFamilyKey(v) === currentFamily) {
        insertAt++
      } else {
        break
      }
    }
  }
  options.splice(insertAt, 0, option)
}

function insertFableOption(options: ModelOption[]): void {
  const custom = getCustomFableOption()
  if (custom) {
    insertPickerOption(options, custom)
    return
  }
  if (isFableAvailable() || getAPIProvider() === 'anthropicAws') {
    insertPickerOption(options, getFable5Option())
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a 3P user (or custom ANTHROPIC_BASE_URL) has a custom opus model string, show it directly
  if (shouldHonorDefaultModelEnvOverrides() && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

function getOpus46Option(fastMode = false): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: is3P ? getModelStrings().opus46 : 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Best for everyday, complex tasks${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 - best for everyday, complex tasks',
  }
}

export function getSonnet46_1MOption(): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: is3P ? getModelStrings().sonnet46 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.6 with 1M context window - for long sessions with large codebases',
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus 4.6 (1M context)',
    description: `Opus 4.6 for long sessions${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 4.6 with 1M context window - for long sessions with large codebases',
  }
}

/** Official 2.1.128 `vi7`: current Opus 4.7 1M shows as "Opus (1M context)". */
function getOpus47_1MOption(): ModelOption {
  const is1P = isFirstPartyApiFamily()
  return {
    value: is1P ? getModelStrings().opus47 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.7 for long sessions${is1P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Opus 4.7 with 1M context window - for long sessions with large codebases',
  }
}

/** Official 2.1.128 `gv6`/`d$H(fE())`: skip a second 4.7 1M row when default Opus is 4.7. */
function isCurrentDefaultOpus47(): boolean {
  if (is1mContextDisabled()) return false
  return getCanonicalName(getDefaultOpusModel()) === 'claude-opus-4-7'
}

function getCustomHaikuOption(): ModelOption | undefined {
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  // When a 3P user (or custom ANTHROPIC_BASE_URL) has a custom haiku model string, show it directly
  if (shouldHonorDefaultModelEnvOverrides() && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.7 · Best for everyday, complex tasks${fastMode ? getOpus46PricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet46_1MOption(): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 with 1M context${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.7 with 1M context${getOpus46PricingSuffix(fastMode)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = !isFirstPartyApiFamily()
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.7 with 1M context · Best for everyday, complex tasks${!is3P && fastMode ? getOpus46PricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      'Opus 4.7 with 1M context - best for everyday, complex tasks',
  }
}

const MaxSonnet46Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 4.6 · Efficient for routine tasks',
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus in plan mode, Sonnet otherwise',
  }
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))

    return [
      getDefaultOptionForUser(),
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getSonnet46Option(),
      getSonnet46_1MOption(),
      getHaiku45Option(),
    ]
  }

  if (isClaudeAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Opus is default, show Sonnet as alternative
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      if (
        !isOpus1mMergeEnabled() &&
        checkOpus1mAccess() &&
        !isCurrentDefaultOpus47()
      ) {
        premiumOptions.push(getMaxOpus46_1MOption(fastMode))
      }

      premiumOptions.push(MaxSonnet46Option)
      if (checkSonnet1mAccess()) {
        premiumOptions.push(getMaxSonnet46_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: Sonnet is default, show Opus as alternative
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      standardOptions.push(getMaxSonnet46_1MOption())
    }

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess() && !isCurrentDefaultOpus47()) {
        standardOptions.push(getMaxOpus46_1MOption(fastMode))
      }
    }

    standardOptions.push(MaxHaiku45Option)
    return standardOptions
  }

  // PAYG 1P API: Default (Sonnet) + Sonnet 1M + Opus 4.6 + Opus 1M + Haiku
  if (isFirstPartyApiFamily()) {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      payg1POptions.push(getSonnet46_1MOption())
    }
    if (isOpus1mMergeEnabled()) {
      payg1POptions.push(getMergedOpus1MOption(fastMode))
    } else {
      payg1POptions.push(getOpus46Option(fastMode))
      if (checkOpus1mAccess()) {
        payg1POptions.push(getOpus46_1MOption(fastMode))
      }
    }
    payg1POptions.push(getHaiku45Option())
    return payg1POptions
  }

  // PAYG 3P: Default (Sonnet 4.5) + Sonnet (3P custom) or Sonnet 4.6/1M + Opus (3P custom) or Opus 4.1/Opus 4.6/Opus1M + Haiku + Opus 4.1
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  const customSonnet = getCustomSonnetOption()
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet)
  } else {
    // Add Sonnet 4.6 since Sonnet 4.5 is the default
    payg3pOptions.push(getSonnet46Option())
    if (checkSonnet1mAccess()) {
      payg3pOptions.push(getSonnet46_1MOption())
    }
  }

  const customOpus = getCustomOpusOption()
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus)
  } else {
    // Add Opus 4.1, Opus 4.6 and Opus 4.6 1M
    payg3pOptions.push(getOpus41Option()) // This is the default opus
    payg3pOptions.push(getOpus46Option(fastMode))
    if (checkOpus1mAccess() && !isCurrentDefaultOpus47()) {
      payg3pOptions.push(getOpus47_1MOption())
    }
  }
  const customHaiku = getCustomHaikuOption()
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  return payg3pOptions
}

// Official 2.1.157 `$a6` / `yv8` / `qa6`. Alias picker rows already embed
// these slogans — do not retarget those. Only the pinned option uses them.
const SLOGAN_SONNET = 'Efficient for routine tasks'
const SLOGAN_OPUS = 'Best for everyday, complex tasks'
const SLOGAN_HAIKU = 'Fastest for quick answers'
const SLOGAN_FABLE = 'Most capable for your hardest and longest-running tasks'

/**
 * Official 2.1.157 `Yr_`: pinned /model row. Family slogan + `(${id})`, or
 * newer-version hint via first-party list index (not marketing-name string).
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const canonical = getCanonicalName(model)
  let family: { alias: string; aliasModel: string; slogan: string } | null =
    null
  // Official 2.1.170 `SD_`: fable before sonnet/opus/haiku.
  if (canonical.includes('fable')) {
    family = {
      alias: 'Fable',
      aliasModel: getDefaultFableModel(),
      slogan: SLOGAN_FABLE,
    }
  } else if (canonical.includes('sonnet')) {
    family = {
      alias: 'Sonnet',
      aliasModel: getDefaultSonnetModel(),
      slogan: SLOGAN_SONNET,
    }
  } else if (canonical.includes('opus')) {
    family = {
      alias: 'Opus',
      aliasModel: getDefaultOpusModel(),
      slogan: SLOGAN_OPUS,
    }
  } else if (canonical.includes('haiku')) {
    family = {
      alias: 'Haiku',
      aliasModel: getDefaultHaikuModel(),
      slogan: SLOGAN_HAIKU,
    }
  }
  if (!family) {
    return {
      value: model,
      label: marketingName,
      description: `Custom model (${model})`,
    }
  }

  const aliasMarketingName = getMarketingNameForModel(family.aliasModel)
  const firstPartyCanonicals = Object.values(ALL_MODEL_CONFIGS).map(cfg =>
    getCanonicalName(cfg.firstParty),
  )
  const pinnedIndex = firstPartyCanonicals.indexOf(canonical)
  if (
    aliasMarketingName &&
    pinnedIndex !== -1 &&
    pinnedIndex <
      firstPartyCanonicals.indexOf(getCanonicalName(family.aliasModel))
  ) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${family.alias} for ${aliasMarketingName}`,
    }
  }

  return {
    value: model,
    label: marketingName,
    description: `${family.slogan} (${model})`,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)
  // Official 2.1.170 `qnH`: insert Fable after the default row.
  insertFableOption(options)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Official 2.1.170 `ID_`: additional cache rows go through `qnH`/`hD6`.
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => samePickerOption(existing, opt))) {
      insertPickerOption(options, opt)
    }
  }

  // Official 2.1.126 `Rl7`: cached gateway `/v1/models` rows
  for (const opt of getGatewayModelOptions()) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (
    typeof customModel === 'string' &&
    isFablePickerValue(customModel)
  ) {
    // Official 2.1.170 `ID_` `PJ$(f)`: reuse the Fable row or insert via `qnH`.
    const idx = options.findIndex(
      o => typeof o.value === 'string' && isFablePickerValue(o.value),
    )
    if (idx !== -1) {
      options[idx] = { ...options[idx]!, value: customModel }
    } else {
      insertPickerOption(options, { ...getFable5Option(), value: customModel })
    }
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opus' && isFirstPartyApiFamily()) {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && isFirstPartyApiFamily()) {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
