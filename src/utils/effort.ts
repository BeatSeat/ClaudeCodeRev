// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialSettings } from './settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { isFirstPartyApiFamily } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import { isWorkflowsEnabled } from './workflows/enabled.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const q = model.toLowerCase()
  // Official 2.1.154 A2: denylist first so ALWAYS_ENABLE cannot force
  // effort onto models that reject the parameter (API 400).
  if (
    q.includes('claude-3-') ||
    q.includes('claude-opus-4-0') ||
    q.includes('claude-opus-4-1') ||
    q.includes('claude-sonnet-4-0') ||
    q.includes('claude-sonnet-4-5') ||
    q.includes('claude-haiku-4-5')
  ) {
    return false
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  if (
    q.includes('fable-5') ||
    q.includes('mythos-5') ||
    q.includes('opus-4-8') ||
    q.includes('opus-4-7') ||
    q.includes('opus-4-6') ||
    q.includes('sonnet-4-6')
  ) {
    return true
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return isFirstPartyApiFamily()
}

// Official 2.1.98: denylist. Unknown/future model IDs default to allowed.
// Haiku never supports max. Legacy 3.x / sonnet-4 / opus-4 (not 4.6) denied.
const MAX_EFFORT_DENIED = new Set([
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-sonnet-4',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-opus-4',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
])

function normalizeEffortModelId(model: string): string {
  const lower = model.toLowerCase()
  const match = lower.match(/claude-[a-z0-9-]+/)
  let id = match ? match[0] : lower
  id = id.replace(/-v\d+(:\d+)?$/, '')
  id = id.replace(/-\d{8}$/, '')
  return id
}

export function modelSupportsXHighEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const lower = model.toLowerCase()
  return (
    lower.includes('fable-5') ||
    lower.includes('mythos-5') ||
    lower.includes('opus-4-8') ||
    lower.includes('opus-4-7')
  )
}

export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (model.toLowerCase().includes('haiku')) {
    return false
  }
  return !MAX_EFFORT_DENIED.has(normalizeEffortModelId(model))
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

/**
 * Official 2.1.160 `ex`. No-arg = workflows on. With model = workflows
 * and that model can run xhigh (ultracode maps only then).
 */
export function isUltracodeEffortAvailable(model?: string): boolean {
  return isWorkflowsEnabled() && (model === undefined || modelSupportsXHighEffort(model))
}

/** Official 2.1.160 `ilH` — trim/lower + alias map + isEffortLevel. No ultracode. */
const EFFORT_ARG_ALIASES: Record<string, string> = { med: 'medium' }

export function parseEffortLevel(value: string): EffortLevel | undefined {
  const normalized = value.trim().toLowerCase()
  const aliased = EFFORT_ARG_ALIASES[normalized] ?? normalized
  return isEffortLevel(aliased) ? aliased : undefined
}

/**
 * Official 2.1.160 `eTA(H,$)`. Slash-arg parse: ultracode → xhigh only when
 * workflows are on AND the model can run xhigh (`ex(model)`). 159 `a3z(H)`
 * gated ultracode on workflows only.
 */
export function parseEffortArg(
  arg: string,
  model?: string,
): { value: EffortValue | undefined } | null {
  const q = arg.toLowerCase()
  if (q === 'auto' || q === 'unset') {
    return { value: undefined }
  }
  if (q === 'ultracode' && isUltracodeEffortAvailable(model)) {
    return { value: 'xhigh' }
  }
  const level = parseEffortLevel(arg)
  return level ? { value: level } : null
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  const pinLaunchDefault = isOpusLaunchEffortPinned(model)
  const modelDefault = getDefaultEffortForModel(model)
  if (envOverride === null) {
    return pinLaunchDefault ? modelDefault : undefined
  }
  const resolved =
    envOverride ??
    (pinLaunchDefault ? modelDefault : undefined) ??
    appStateEffortValue ??
    modelDefault
  // API rejects 'max' / 'xhigh' on models that don't support them.
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  if (resolved === 'xhigh' && !modelSupportsXHighEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Deeper reasoning than high, just below maximum (Fable 5, Opus 4.7+)'
    case 'max':
      return 'Maximum capability with deepest reasoning. May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  const canonical = model.toLowerCase()
  if (canonical.includes('opus-4-7')) {
    return 'xhigh'
  }

  // Official 2.1.117 JQ8: Pro/Max default on Opus 4.6 / Sonnet 4.6 is high
  // (was medium). External users always fall through to high.
  return 'high'
}

/** Official 2.1.111 SF1: persist an explicit /effort or --effort choice and unpin the Opus 4.7 launch default. */
export function applyEffortSelection(
  value: unknown,
): EffortValue | undefined {
  const parsed = parseEffortValue(value)
  if (parsed !== undefined) {
    unpinOpusLaunchEffort()
  }
  return parsed ?? getInitialEffortSetting()
}

/** Official 2.1.170 `h8H`. */
function isDefaultFableModelEnv(model: string): boolean {
  const env = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (!env) return false
  return model.replace(/\[1m]$/, '') === env.replace(/\[1m]$/, '')
}

/** Official 2.1.154 `AkH` / 2.1.170 `ckH`: pin launch defaults until /effort. */
export function isOpusLaunchEffortPinned(model: string): boolean {
  const lower = model.toLowerCase()
  const cfg = getGlobalConfig()
  if (lower.includes('opus-4-7')) {
    return !cfg.unpinOpus47LaunchEffort
  }
  if (lower.includes('opus-4-8')) {
    return !cfg.unpinOpus48LaunchEffort
  }
  if (lower.includes('fable-5') || isDefaultFableModelEnv(model)) {
    return !cfg.unpinFable5LaunchEffort
  }
  return false
}

export function unpinOpus47LaunchEffort(): void {
  unpinOpusLaunchEffort()
}

/** Official 2.1.154 `SI` / 2.1.170 `BC`: write all launch-effort unpin flags together. */
export function unpinOpusLaunchEffort(): void {
  saveGlobalConfig(current =>
    current.unpinOpus47LaunchEffort &&
    current.unpinOpus48LaunchEffort &&
    current.unpinFable5LaunchEffort
      ? current
      : {
          ...current,
          unpinOpus47LaunchEffort: true,
          unpinOpus48LaunchEffort: true,
          unpinFable5LaunchEffort: true,
        },
  )
}
