import { logEvent } from '../../services/analytics/index.js'
import { refreshAndGetAwsCredentials } from '../auth.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'
import { getProxyFetchOptions } from '../proxy.js'
import {
  ALL_MODEL_CONFIGS,
  type ModelKey,
} from './configs.js'
import { findFirstMatch, getBedrockInferenceProfiles } from './bedrock.js'
import { firstPartyNameToCanonical, getMarketingNameForModel } from './model.js'
import { getAPIProvider } from './providers.js'

export const BEDROCK_TIER_LABELS = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
} as const

export type BedrockTier = keyof typeof BEDROCK_TIER_LABELS

/**
 * Official 2.1.94/98 default keys for Bedrock upgrade/fallback.
 * 3P Sonnet stays on 4.5 even after 1P moves to 4.6.
 */
const DEFAULT_TIER_KEYS: Record<BedrockTier, ModelKey> = {
  sonnet: 'sonnet45',
  opus: 'opus46',
  haiku: 'haiku45',
}

const TIER_ENV: Record<
  BedrockTier,
  { envVarPriority: string[]; defaultKey: ModelKey }
> = {
  sonnet: {
    envVarPriority: ['ANTHROPIC_DEFAULT_SONNET_MODEL'],
    defaultKey: DEFAULT_TIER_KEYS.sonnet,
  },
  opus: {
    envVarPriority: ['ANTHROPIC_DEFAULT_OPUS_MODEL'],
    defaultKey: DEFAULT_TIER_KEYS.opus,
  },
  haiku: {
    envVarPriority: [
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ],
    defaultKey: DEFAULT_TIER_KEYS.haiku,
  },
}

const MODEL_KEY_ORDER = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

export type BedrockUpgradeCandidate = {
  tier: BedrockTier
  envVar: string
  fromKey: ModelKey
  fromMarketingName: string
  toKey: ModelKey
  toMarketingName: string
  toBedrockId: string
}

export type BedrockDefaultFallback = {
  tier: BedrockTier
  envVar: string
  defaultKey: ModelKey
  defaultName: string
  fallbackKey: ModelKey
  fallbackName: string
  fallbackBedrockId: string
}

function tierOfKey(key: ModelKey): BedrockTier | undefined {
  if (key.startsWith('sonnet')) return 'sonnet'
  if (key.startsWith('opus')) return 'opus'
  if (key.startsWith('haiku')) return 'haiku'
  return undefined
}

function modelKeyForPinnedId(pinnedRaw: string): ModelKey | undefined {
  const canonical = firstPartyNameToCanonical(pinnedRaw)
  for (const key of MODEL_KEY_ORDER) {
    if (
      firstPartyNameToCanonical(ALL_MODEL_CONFIGS[key].firstParty) === canonical
    ) {
      return key
    }
  }
  return undefined
}

export function bedrockUpgradeKey(candidate: {
  fromKey: string
  toKey: string
}): string {
  return `${candidate.fromKey}-to-${candidate.toKey}`
}

function olderKeyInTier(
  defaultKey: ModelKey,
  tier: BedrockTier,
): ModelKey | undefined {
  const start = MODEL_KEY_ORDER.indexOf(defaultKey)
  for (let i = start - 1; i >= 0; i--) {
    const key = MODEL_KEY_ORDER[i]
    if (key && tierOfKey(key) === tier) return key
  }
  return undefined
}

function shouldSkipProviderManaged(): boolean {
  return (
    getAPIProvider() !== 'bedrock' ||
    isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)
  )
}

/** Official 2.1.94 so8. */
export async function probeBedrockModel(
  modelId: string,
  tier: BedrockTier,
): Promise<boolean> {
  try {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    const awsRegion =
      tier === 'haiku' && process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()
    const args = {
      awsRegion,
      maxRetries: 0,
      timeout: 8000,
      fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
    }
    let client
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      client = new AnthropicBedrock({
        ...args,
        skipAuth: true,
        defaultHeaders: {
          Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
        },
      })
    } else {
      const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)
      const creds = skipAuth ? null : await refreshAndGetAwsCredentials()
      client = creds
        ? new AnthropicBedrock({
            ...args,
            awsAccessKey: creds.accessKeyId,
            awsSecretKey: creds.secretAccessKey,
            awsSessionToken: creds.sessionToken,
          })
        : new AnthropicBedrock({
            ...args,
            ...(skipAuth && { skipAuth: true }),
          })
    }
    await client.messages.create({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    })
    return true
  } catch (err) {
    if ((err as { status?: number } | undefined)?.status === 429) return true
    return false
  }
}

/** Official 2.1.94 DKO. */
export async function findBedrockUpgradeCandidates(): Promise<
  BedrockUpgradeCandidate[]
> {
  if (shouldSkipProviderManaged()) return []

  const stale: Array<{
    tier: BedrockTier
    envVar: string
    pinnedRaw: string
    pinnedKey: ModelKey
    defaultKey: ModelKey
  }> = []

  for (const tier of Object.keys(TIER_ENV) as BedrockTier[]) {
    const spec = TIER_ENV[tier]
    let envVar: string | undefined
    let pinnedRaw: string | undefined
    for (const name of spec.envVarPriority) {
      const value = process.env[name]
      if (value) {
        envVar = name
        pinnedRaw = value
        break
      }
    }
    if (!envVar || !pinnedRaw) continue
    if (pinnedRaw.includes('application-inference-profile')) continue
    const pinnedKey = modelKeyForPinnedId(pinnedRaw)
    if (!pinnedKey) continue
    if (tierOfKey(pinnedKey) !== tier) continue
    if (pinnedKey === spec.defaultKey) continue
    const pinnedIdx = MODEL_KEY_ORDER.indexOf(pinnedKey)
    const defaultIdx = MODEL_KEY_ORDER.indexOf(spec.defaultKey)
    if (pinnedIdx >= defaultIdx) continue
    stale.push({
      tier,
      envVar,
      pinnedRaw,
      pinnedKey,
      defaultKey: spec.defaultKey,
    })
  }
  if (stale.length === 0) return []

  let profiles: string[]
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch {
    return []
  }

  const probed: BedrockUpgradeCandidate[] = []
  for (const row of stale) {
    const needle = ALL_MODEL_CONFIGS[row.defaultKey].firstParty
    const toBedrockId = findFirstMatch(profiles, needle)
    if (!toBedrockId) continue
    const fromMarketingName = getMarketingNameForModel(
      ALL_MODEL_CONFIGS[row.pinnedKey].firstParty,
    )
    const toMarketingName = getMarketingNameForModel(needle)
    if (!fromMarketingName || !toMarketingName) continue
    probed.push({
      tier: row.tier,
      envVar: row.envVar,
      fromKey: row.pinnedKey,
      fromMarketingName,
      toKey: row.defaultKey,
      toMarketingName,
      toBedrockId,
    })
  }

  logEvent('tengu_bedrock_upgrade_check', {
    stale_tiers: String(probed.length),
  })

  const accessible = await Promise.all(
    probed.map(async candidate => {
      const ok = await probeBedrockModel(candidate.toBedrockId, candidate.tier)
      logEvent('tengu_bedrock_probe_result', {
        tier: candidate.tier,
        model_id: candidate.toBedrockId,
        accessible: String(ok),
      })
      return ok ? candidate : null
    }),
  )
  return accessible.filter((row): row is BedrockUpgradeCandidate => row !== null)
}

/** Official 2.1.94 fKO. */
export async function checkBedrockDefaultAvailability(): Promise<
  BedrockDefaultFallback[]
> {
  if (shouldSkipProviderManaged()) return []

  const unpinned: Array<{
    tier: BedrockTier
    envVar: string
    defaultKey: ModelKey
  }> = []
  for (const tier of Object.keys(TIER_ENV) as BedrockTier[]) {
    const spec = TIER_ENV[tier]
    if (spec.envVarPriority.some(name => process.env[name])) continue
    unpinned.push({
      tier,
      envVar: spec.envVarPriority[0]!,
      defaultKey: spec.defaultKey,
    })
  }
  if (unpinned.length === 0) return []

  logEvent('tengu_bedrock_default_check', {
    unpinned_tiers: String(unpinned.length),
  })

  let profiles: string[]
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch {
    return []
  }

  const rows = await Promise.all(
    unpinned.map(async row => {
      const defaultCfg = ALL_MODEL_CONFIGS[row.defaultKey]
      const defaultId = findFirstMatch(profiles, defaultCfg.firstParty)
      if (!defaultId) return null
      const defaultOk = await probeBedrockModel(defaultId, row.tier)
      logEvent('tengu_bedrock_probe_result', {
        tier: row.tier,
        model_id: defaultId,
        accessible: String(defaultOk),
      })
      if (defaultOk) return null
      const fallbackKey = olderKeyInTier(row.defaultKey, row.tier)
      if (!fallbackKey) return null
      const fallbackCfg = ALL_MODEL_CONFIGS[fallbackKey]
      const fallbackId = findFirstMatch(profiles, fallbackCfg.firstParty)
      if (!fallbackId) return null
      if (!(await probeBedrockModel(fallbackId, row.tier))) return null
      const defaultName = getMarketingNameForModel(defaultCfg.firstParty)
      const fallbackName = getMarketingNameForModel(fallbackCfg.firstParty)
      if (!defaultName || !fallbackName) return null
      return {
        tier: row.tier,
        envVar: row.envVar,
        defaultKey: row.defaultKey,
        defaultName,
        fallbackKey,
        fallbackName,
        fallbackBedrockId: fallbackId,
      } satisfies BedrockDefaultFallback
    }),
  )
  return rows.filter((row): row is BedrockDefaultFallback => row !== null)
}

export function bedrockPinEnvPatch(
  tier: BedrockTier,
  envVar: string,
  modelId: string,
): Record<string, string> {
  if (tier === 'haiku') {
    return {
      ANTHROPIC_SMALL_FAST_MODEL: modelId,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    }
  }
  return { [envVar]: modelId }
}

export function applyBedrockPinEnv(
  tier: BedrockTier,
  envVar: string,
  modelId: string,
): Record<string, string> {
  const patch = bedrockPinEnvPatch(tier, envVar, modelId)
  for (const [key, value] of Object.entries(patch)) {
    process.env[key] = value
  }
  return patch
}
