import { logEvent } from '../../services/analytics/index.js'
import { refreshGcpCredentialsIfNeeded } from '../auth.js'
import { getVertexRegionForModel, isEnvTruthy } from '../envUtils.js'
import { logForDebugging } from '../debug.js'
import { getProxyFetchOptions } from '../proxy.js'
import { ALL_MODEL_CONFIGS, type ModelKey } from './configs.js'
import { firstPartyNameToCanonical, getMarketingNameForModel } from './model.js'
import { getAPIProvider } from './providers.js'

export const VERTEX_TIER_LABELS = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
} as const

export type VertexTier = keyof typeof VERTEX_TIER_LABELS

/** Official 2.1.98 Ga8 — same 3P defaults as Bedrock (Sonnet stays 4.5). */
const DEFAULT_TIER_KEYS: Record<VertexTier, ModelKey> = {
  sonnet: 'sonnet45',
  opus: 'opus46',
  haiku: 'haiku45',
}

const TIER_ENV: Record<
  VertexTier,
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

export type VertexUpgradeCandidate = {
  tier: VertexTier
  envVar: string
  fromKey: ModelKey
  fromMarketingName: string
  toKey: ModelKey
  toMarketingName: string
  toVertexId: string
}

export type VertexDefaultFallback = {
  tier: VertexTier
  envVar: string
  defaultKey: ModelKey
  defaultName: string
  fallbackKey: ModelKey
  fallbackName: string
  fallbackVertexId: string
}

function tierOfKey(key: ModelKey): VertexTier | undefined {
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

export function vertexUpgradeKey(candidate: {
  fromKey: string
  toKey: string
}): string {
  return `${candidate.fromKey}-to-${candidate.toKey}`
}

function olderKeyInTier(
  defaultKey: ModelKey,
  tier: VertexTier,
): ModelKey | undefined {
  const start = MODEL_KEY_ORDER.indexOf(defaultKey)
  for (let i = start - 1; i >= 0; i--) {
    const key = MODEL_KEY_ORDER[i]
    if (key && tierOfKey(key) === tier) return key
  }
  return undefined
}

function shouldSkip(): boolean {
  return (
    getAPIProvider() !== 'vertex' ||
    isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)
  )
}

/** Official 2.1.98 fa8. */
export async function probeVertexModel(modelId: string): Promise<boolean> {
  try {
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }
    const [{ AnthropicVertex }, { GoogleAuth }] = await Promise.all([
      import('@anthropic-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    const hasProjectEnvVar =
      process.env.GCLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.gcloud_project ||
      process.env.google_cloud_project
    const hasKeyFile =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.google_application_credentials
    const googleAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
      ? ({
          getClient: () => ({
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : { projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID }),
        })
    const client = new AnthropicVertex({
      region: getVertexRegionForModel(modelId),
      googleAuth,
      maxRetries: 0,
      timeout: 8000,
      fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
    })
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

/** Official 2.1.98 A9A. */
export async function findVertexUpgradeCandidates(): Promise<
  VertexUpgradeCandidate[]
> {
  if (shouldSkip()) return []

  const stale: Array<{
    tier: VertexTier
    envVar: string
    pinnedKey: ModelKey
    defaultKey: ModelKey
  }> = []

  for (const tier of Object.keys(TIER_ENV) as VertexTier[]) {
    const spec = TIER_ENV[tier]
    let envVar: string | undefined
    let pinnedKey: ModelKey | undefined
    for (const name of spec.envVarPriority) {
      const value = process.env[name]
      if (!value) continue
      const key = modelKeyForPinnedId(value)
      if (!key || tierOfKey(key) !== tier || key === spec.defaultKey) continue
      envVar = name
      pinnedKey = key
      break
    }
    if (!envVar || !pinnedKey) continue
    const pinnedIdx = MODEL_KEY_ORDER.indexOf(pinnedKey)
    const defaultIdx = MODEL_KEY_ORDER.indexOf(spec.defaultKey)
    if (pinnedIdx >= defaultIdx) continue
    stale.push({
      tier,
      envVar,
      pinnedKey,
      defaultKey: spec.defaultKey,
    })
  }
  if (stale.length === 0) return []

  logEvent('tengu_vertex_upgrade_check', {
    stale_tiers: String(stale.length),
  })

  const accessible = await Promise.all(
    stale.map(async row => {
      const toVertexId = ALL_MODEL_CONFIGS[row.defaultKey].vertex
      const ok = await probeVertexModel(toVertexId)
      logEvent('tengu_vertex_probe_result', {
        tier: row.tier,
        model_id: toVertexId,
        accessible: String(ok),
      })
      if (!ok) return null
      const fromMarketingName = getMarketingNameForModel(
        ALL_MODEL_CONFIGS[row.pinnedKey].firstParty,
      )
      const toMarketingName = getMarketingNameForModel(
        ALL_MODEL_CONFIGS[row.defaultKey].firstParty,
      )
      if (!fromMarketingName || !toMarketingName) return null
      return {
        tier: row.tier,
        envVar: row.envVar,
        fromKey: row.pinnedKey,
        fromMarketingName,
        toKey: row.defaultKey,
        toMarketingName,
        toVertexId,
      } satisfies VertexUpgradeCandidate
    }),
  )
  const candidates = accessible.filter(
    (row): row is VertexUpgradeCandidate => row !== null,
  )
  logForDebugging(
    `[vertex-upgrade] tiersWithPin=${stale.length} candidates=${candidates.length}`,
  )
  return candidates
}

/** Official 2.1.98 O9A. */
export async function checkVertexDefaultAvailability(): Promise<
  VertexDefaultFallback[]
> {
  if (shouldSkip()) return []

  const unpinned: Array<{
    tier: VertexTier
    envVar: string
    defaultKey: ModelKey
  }> = []
  for (const tier of Object.keys(TIER_ENV) as VertexTier[]) {
    const spec = TIER_ENV[tier]
    const consideredPinned = spec.envVarPriority.some(name => {
      const value = process.env[name]
      if (!value) return false
      const key = modelKeyForPinnedId(value)
      if (!key) return true
      return tierOfKey(key) === tier
    })
    if (consideredPinned) continue
    unpinned.push({
      tier,
      envVar: spec.envVarPriority.at(-1)!,
      defaultKey: spec.defaultKey,
    })
  }
  if (unpinned.length === 0) return []

  logEvent('tengu_vertex_default_check', {
    unpinned_tiers: String(unpinned.length),
  })

  const rows = await Promise.all(
    unpinned.map(async row => {
      const defaultCfg = ALL_MODEL_CONFIGS[row.defaultKey]
      const defaultOk = await probeVertexModel(defaultCfg.vertex)
      logEvent('tengu_vertex_probe_result', {
        tier: row.tier,
        model_id: defaultCfg.vertex,
        accessible: String(defaultOk),
      })
      if (defaultOk) return null
      const fallbackKey = olderKeyInTier(row.defaultKey, row.tier)
      if (!fallbackKey) return null
      const fallbackCfg = ALL_MODEL_CONFIGS[fallbackKey]
      if (!(await probeVertexModel(fallbackCfg.vertex))) return null
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
        fallbackVertexId: fallbackCfg.vertex,
      } satisfies VertexDefaultFallback
    }),
  )
  const fallbacks = rows.filter(
    (row): row is VertexDefaultFallback => row !== null,
  )
  logForDebugging(
    `[vertex-fallback] unpinnedTiers=${unpinned.length} fallbacks=${fallbacks.length}`,
  )
  return fallbacks
}

/** Official 2.1.98 haiku pin: always DEFAULT_HAIKU, plus SMALL_FAST when that was the pin. */
export function vertexPinEnvPatch(
  tier: VertexTier,
  envVar: string,
  modelId: string,
): Record<string, string> {
  if (tier === 'haiku') {
    return {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
      ...(envVar === 'ANTHROPIC_SMALL_FAST_MODEL'
        ? { ANTHROPIC_SMALL_FAST_MODEL: modelId }
        : {}),
    }
  }
  return { [envVar]: modelId }
}

export function applyVertexPinEnv(
  tier: VertexTier,
  envVar: string,
  modelId: string,
): Record<string, string> {
  const patch = vertexPinEnvPatch(tier, envVar, modelId)
  for (const [key, value] of Object.entries(patch)) {
    process.env[key] = value
  }
  return patch
}
