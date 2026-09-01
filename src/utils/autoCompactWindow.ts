import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { formatTokens } from './format.js'
import { getInitialSettings, updateSettingsForSource } from './settings/settings.js'

/** Official 2.1.89 D17 / V47 / k47 */
export const AUTO_COMPACT_WINDOW_MIN = 100_000
/** Official 2.1.89 jfK / N47 */
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000
/** Official 2.1.89 k47 — dialog step */
export const AUTO_COMPACT_WINDOW_STEP = 100_000

export type AutoCompactWindowSource = 'env' | 'settings' | 'model'

export type ResolvedAutoCompactWindow = {
  window: number
  configured: number
  source: AutoCompactWindowSource
}

/**
 * Official 2.1.89 HfK: `500k` / `200000` / `200` (100–1000 → thousands) or `1m`.
 */
export function parseAutoCompactWindowArg(raw: string): number | undefined {
  const k = raw.trim().toLowerCase()
  let n: number
  if (k.endsWith('m')) {
    n = parseFloat(k) * 1e6
  } else if (k.endsWith('k')) {
    n = parseFloat(k) * 1000
  } else {
    const z = parseInt(k, 10)
    n = z >= 100 && z <= 1000 ? z * 1000 : z
  }
  if (
    !Number.isFinite(n) ||
    n < AUTO_COMPACT_WINDOW_MIN ||
    n > AUTO_COMPACT_WINDOW_MAX
  ) {
    return undefined
  }
  return Math.round(n)
}

/**
 * Official 2.1.89 VU + j56 env branch: invalid → ignore; else clamp to [100k, 1M].
 */
export function parseEnvAutoCompactWindow(
  raw: string | undefined,
): number | undefined {
  if (!raw) return undefined
  const y = parseInt(raw, 10)
  if (isNaN(y) || y <= 0) return undefined
  return Math.max(AUTO_COMPACT_WINDOW_MIN, Math.min(y, AUTO_COMPACT_WINDOW_MAX))
}

/**
 * Official 2.1.89 j56: env > settings > model. `window` is min(model, configured).
 */
export function resolveAutoCompactWindow(
  modelWindow: number,
  settingsWindow: number | undefined,
): ResolvedAutoCompactWindow {
  const envConfigured = parseEnvAutoCompactWindow(
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  )
  if (envConfigured !== undefined) {
    return {
      window: Math.min(modelWindow, envConfigured),
      configured: envConfigured,
      source: 'env',
    }
  }
  if (settingsWindow !== undefined) {
    return {
      window: Math.min(modelWindow, settingsWindow),
      configured: settingsWindow,
      source: 'settings',
    }
  }
  return {
    window: modelWindow,
    configured: modelWindow,
    source: 'model',
  }
}

export function sourceLabel(source: AutoCompactWindowSource): string {
  if (source === 'env') return 'from CLAUDE_CODE_AUTO_COMPACT_WINDOW'
  if (source === 'settings') return 'from settings'
  return 'model default'
}

export function formatAutoCompactWindowStatus(
  resolved: ResolvedAutoCompactWindow,
  autoCompactEnabled: boolean,
): string {
  const capped =
    resolved.configured > resolved.window
      ? ` · capped to ${formatTokens(resolved.window)} by model`
      : ''
  const lines = [
    `Auto-compact window: ${formatTokens(resolved.configured)} tokens (${sourceLabel(resolved.source)})${capped}`,
  ]
  if (!autoCompactEnabled) {
    lines.push('Auto-compact is currently disabled (see /config)')
  }
  lines.push(
    'Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model\'s context window.',
  )
  return lines.join('\n')
}

export function applyAutoCompactWindow(
  tokens: number | undefined,
): { settingsWindow: number | undefined } {
  updateSettingsForSource('userSettings', { autoCompactWindow: tokens })
  logEvent('tengu_autocompact_command', {
    action: tokens === undefined ? 'reset' : 'set',
    ...(tokens !== undefined && {
      tokens: tokens as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })
  return { settingsWindow: getInitialSettings().autoCompactWindow }
}

/** Official 2.1.89 b78 */
export function setAutoCompactWindowFromArg(
  arg: string,
  modelWindow: number,
): string {
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    return 'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.'
  }
  const z = arg.trim().toLowerCase()
  const isReset = z === 'reset' || z === 'unset' || z === 'default'
  const tokens = isReset ? undefined : parseAutoCompactWindowArg(z)
  if (!isReset && tokens === undefined) {
    return `Invalid argument: ${arg}. Expected 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand) or 'reset'`
  }
  applyAutoCompactWindow(tokens)
  const settingsWindow = getInitialSettings().autoCompactWindow
  const resolved = resolveAutoCompactWindow(modelWindow, settingsWindow)
  const overrideActive =
    resolved.source === 'env' || settingsWindow !== tokens
  if (isReset) {
    return overrideActive
      ? `Auto-compact window reset in settings, but a higher-priority override is active (${formatTokens(resolved.window)} tokens)`
      : 'Auto-compact window reset to model default'
  }
  let suffix = ''
  if (overrideActive) {
    suffix = `, but a higher-priority override is active (${formatTokens(resolved.window)} tokens)`
  } else if (resolved.window < tokens!) {
    suffix = ` (capped to model limit of ${formatTokens(resolved.window)})`
  }
  return `Auto-compact window set to ${formatTokens(tokens!)} tokens${suffix}`
}
