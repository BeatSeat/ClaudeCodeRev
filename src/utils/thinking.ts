// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getGlobalConfig } from './config.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import {
  getAPIProvider,
  getAPIProviderForModel,
  isCapabilityApiFamily,
  isFirstPartyApiFamily,
} from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

/** Official 2.1.170 `XD_` / `HnH` (was 169 `fV_` / `bnH`). */
const FABLE_FAMILY_CODENAMES = ['fable', 'fruitcake', 'macaroon', 'mythos']

export function isFableFamilyThinkingModel(model: string): boolean {
  const lower = model.toLowerCase()
  if (FABLE_FAMILY_CODENAMES.some(name => lower.includes(name))) {
    return true
  }
  const env = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (!env) return false
  return model.replace(/\[1m]$/, '') === env.replace(/\[1m]$/, '')
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProviderForModel(model)
  // 1P, Foundry, and Mantle: all Claude 4+ models (including Haiku 4.5)
  if (isCapabilityApiFamily(provider)) {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Official 2.1.170 `$nH`: fable/mythos/opus-4-8 join the adaptive allowlist.
  if (
    canonical.includes('fable-5') ||
    canonical.includes('mythos-5') ||
    canonical.includes('opus-4-8') ||
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('sonnet-4-6')
  ) {
    return true
  }
  // Exclude any other known legacy models (allowlist above catches 4-6 variants first)
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Newer models (4.6+) are all trained on adaptive thinking and MUST have it
  // enabled for model testing. DO NOT default to false for first party, otherwise
  // we may silently degrade model quality.

  // Default to true for unknown model strings on 1P and Foundry (because Foundry
  // is a proxy). Do not default to true for other 3P as they have different formats
  // for their model strings.
  const provider = getAPIProvider()
  return isFirstPartyApiFamily(provider) || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}

/**
 * Official 2.1.107 FH7: opus-4-6 + clientDataCache.loud_sugary_rock.
 * Gates the thinking_guidance system-prompt section and the per-turn
 * "skip thinking unless redesign" meta reminder (meK).
 */
export function isThinkingGuidanceEnabled(model: string): boolean {
  if (!getCanonicalName(model).includes('opus-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['loud_sugary_rock'] === 'true'
}

/**
 * Official 2.1.165 hM8 — clientDataCache.cedar_lagoon per-model thinking
 * keep-alive. Map of model-id substring → true; when the canonical family
 * id of the main-loop model matches a true entry, the session keeps its
 * thinking config instead of forcing {type:'disabled'}.
 */
export function isThinkingEnabledByClientFlag(model: string): boolean {
  const flag = getGlobalConfig().clientDataCache?.cedar_lagoon
  if (typeof flag !== 'object' || flag === null) return false
  const canonical = getCanonicalName(model)
  return Object.entries(flag).some(
    ([key, value]) => value === true && canonical.includes(key),
  )
}

/**
 * Official 2.1.107 NeY — system-prompt section `thinking_guidance`.
 */
export function getThinkingGuidanceSection(model: string): string | null {
  if (!isThinkingGuidanceEnabled(model)) {
    return null
  }
  return `# System reminders
User messages include a <system-reminder> appended by this harness. These reminders are not from the user, so treat them as an instruction to you, and do not mention them. The reminders are intended to tune your thinking frequency - on simpler user messages, it's best to respond or act directly without thinking unless further reasoning is necessary. On more complex tasks, you should feel free to reason as much as needed for best results but without overthinking. Avoid unnecessary thinking in response to simple user messages.`
}

/**
 * Official 2.1.107 meK — injected as an isMeta user message after the first
 * assistant turn so long operations show a thinking-frequency hint sooner.
 */
export const THINKING_FREQUENCY_REMINDER =
  '<system-reminder>Respond with just the action or changes and without a thinking block, unless this is a redesign or requires fresh reasoning.</system-reminder>'
