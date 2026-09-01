import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../auth.js'
import { getAPIProvider } from '../model/providers.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { logOTelEvent } from '../telemetry/events.js'
import { ALLOWED_OFFICIAL_MARKETPLACE_NAMES } from './schemas.js'

const PLUGIN_HOOK_METRICS_MAX_FIELDS = 20

function isOfficialMarketplacePluginId(pluginId: string): boolean {
  const at = pluginId.lastIndexOf('@')
  if (at <= 0) return false
  return ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(pluginId.slice(at + 1))
}

/**
 * Official 2.1.144 `ip5`. GrowthBook `tengu_amber_lattice` is an allowlist
 * (`{plugins?: string[]}`, default `{}`), not a boolean kill switch.
 */
export function isAmberLatticePlugin(pluginId: string): boolean {
  if (!isOfficialMarketplacePluginId(pluginId)) return false
  const name = pluginId.slice(0, pluginId.lastIndexOf('@'))
  const cfg = getFeatureValue_CACHED_MAY_BE_STALE<{ plugins?: string[] }>(
    'tengu_amber_lattice',
    {},
  )
  return (cfg.plugins ?? []).includes(name)
}

/**
 * Official 2.1.144 `NS4`. Inject first-party auth into allowlisted official
 * plugin hook subprocesses. Empty object when gated off.
 */
export function getAmberLatticePluginAuthEnv(
  pluginId: string | undefined,
): Record<string, string> {
  if (!pluginId || !isAmberLatticePlugin(pluginId)) return {}
  if (getAPIProvider() !== 'firstParty') return {}
  if (isEssentialTrafficOnly()) return {}
  if (process.env.ANTHROPIC_UNIX_SOCKET) return {}
  try {
    if (isClaudeAISubscriber()) {
      const token = getClaudeAIOAuthTokens()?.accessToken
      return token ? { ANTHROPIC_AUTH_TOKEN: token } : {}
    }
    const key = getAnthropicApiKey()
    return key ? { ANTHROPIC_API_KEY: key } : {}
  } catch {
    return {}
  }
}

/**
 * Official 2.1.144 `f$H`. Log boolean/number metrics from official-marketplace
 * plugin hook JSON (`tengu_hook_plugin_metrics` + OTEL `hook_plugin_metrics`).
 */
export function emitPluginHookMetrics(
  metrics: Record<string, unknown> | undefined,
  pluginId: string | undefined,
  hookEvent: string,
): void {
  if (!metrics || !pluginId) return
  if (!isOfficialMarketplacePluginId(pluginId)) return
  const entries = Object.entries(metrics)
    .slice(0, PLUGIN_HOOK_METRICS_MAX_FIELDS)
    .filter(
      (entry): entry is [string, boolean | number] =>
        typeof entry[1] === 'boolean' || typeof entry[1] === 'number',
    )
  const payload = Object.fromEntries(entries)
  logEvent('tengu_hook_plugin_metrics', {
    ...payload,
    pluginId:
      pluginId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    hookEvent:
      hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  void logOTelEvent('hook_plugin_metrics', {
    ...payload,
    plugin_id: pluginId,
    hook_event: hookEvent,
  })
}
