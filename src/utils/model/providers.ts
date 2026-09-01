import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type CloudProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'anthropicAws'
export type APIProvider = CloudProvider | 'mantle'

export function isMantleEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_MANTLE)
}

export function isAnthropicAwsEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)
}

/**
 * Official 2.1.90+ G$/K2: first-party API family includes Anthropic-on-AWS
 * (same model IDs and API shape; different auth/endpoint).
 */
export function isFirstPartyApiFamily(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return provider === 'firstParty' || provider === 'anthropicAws'
}

/** Env-selected cloud providers that skip 1P OAuth / error reporting. */
export function isThirdPartyCloudEnv(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    isAnthropicAwsEnabled() ||
    isMantleEnabled()
  )
}

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
      ? 'foundry'
      : isAnthropicAwsEnabled()
        ? 'anthropicAws'
        : isMantleEnabled()
          ? 'mantle'
          : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
            ? 'vertex'
            : 'firstParty'
}

/**
 * Official 94 OW8 / 108 ED8: when Bedrock is the env provider and Mantle is
 * also on, overlay Mantle as a secondary provider (combo /status, dual-env
 * unversioned anthropic.* IDs).
 */
export function getBedrockMantleOverlay(): 'mantle' | null {
  return getAPIProvider() === 'bedrock' && isMantleEnabled() ? 'mantle' : null
}

/** Official 94 ID9 / 108 Zv9: unversioned `anthropic.*` (no `-vN` / `:N`). */
function isUnversionedAnthropicModelId(model: string): boolean {
  return model.startsWith('anthropic.') && !/-v\d+(:\d+)?$/.test(model)
}

/**
 * Official 94 IJ / 108 aX: env provider, unless Bedrock+Mantle dual-env and
 * the model is an unversioned `anthropic.*` ID (then Mantle).
 */
export function getAPIProviderForModel(model?: string): APIProvider {
  if (model) {
    const overlay = getBedrockMantleOverlay()
    if (overlay === 'mantle' && isUnversionedAnthropicModelId(model)) {
      return overlay
    }
  }
  return getAPIProvider()
}

/**
 * Official 94 ru / 108 iU: 1P-shaped capability routing (thinking +
 * structured outputs). Foundry and Mantle follow 1P, not Bedrock-3P.
 */
export function isCapabilityApiFamily(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return (
    isFirstPartyApiFamily(provider) ||
    provider === 'foundry' ||
    provider === 'mantle'
  )
}

/** Model-config lookup key. Mantle reuses Bedrock model IDs. */
export function getCloudProvider(): CloudProvider {
  const provider = getAPIProvider()
  return provider === 'mantle' ? 'bedrock' : provider
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
