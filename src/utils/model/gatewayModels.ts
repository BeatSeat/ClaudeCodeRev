import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { getAnthropicApiKey } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getUserAgent } from '../http.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { getProxyFetchOptions } from '../proxy.js'
import { jsonStringify } from '../slowOperations.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

const GATEWAY_FETCH_TIMEOUT_MS = 3000
const ANTHROPIC_VERSION = '2023-06-01'

const GatewayModelSchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      display_name: z.string().optional(),
    })
    .strip(),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    baseUrl: z.string(),
    fetchedAt: z.number(),
    models: z.array(GatewayModelSchema()),
  }),
)

type GatewayModel = z.infer<ReturnType<typeof GatewayModelSchema>>

/**
 * Official 2.1.126 `hl7`: custom first-party gateway, not api.anthropic.com.
 * Official 2.1.129 `br7`: discovery is opt-in — 126–128 probed /v1/models
 * automatically whenever ANTHROPIC_BASE_URL pointed at a gateway.
 */
export function isGatewayModelDiscoveryEligible(): boolean {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY))
    return false
  if (getAPIProvider() !== 'firstParty') return false
  if (isFirstPartyAnthropicBaseUrl()) return false
  if (!process.env.ANTHROPIC_BASE_URL) return false
  return true
}

function getCacheDir(): string {
  return join(getClaudeConfigHomeDir(), 'cache')
}

function getCachePath(): string {
  return join(getCacheDir(), 'gateway-models.json')
}

const loadCache = memoize(
  (path: string): z.infer<ReturnType<typeof CacheFileSchema>> | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getGatewayModelOptions
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  },
  path => path,
)

function parseGatewayCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split(
    /\r?\n/,
  )) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}

/** Official 2.1.126 `Rl7`: cached `/model` picker rows (`From gateway`). */
export function getGatewayModelOptions(): Array<{
  value: string
  label: string
  description: string
}> {
  if (!isGatewayModelDiscoveryEligible()) return []
  const cached = loadCache(getCachePath())
  if (!cached || cached.baseUrl !== process.env.ANTHROPIC_BASE_URL) {
    return []
  }
  return cached.models.map(model => ({
    value: model.id,
    label: model.display_name || model.id,
    description: 'From gateway',
  }))
}

/** Official 2.1.126 `Cl7`: `GET ${base}/v1/models?limit=1000` (fetch, not SDK). */
export async function refreshGatewayModels(): Promise<void> {
  if (!isGatewayModelDiscoveryEligible()) return
  if (isEssentialTrafficOnly()) return

  try {
    const baseUrl = process.env.ANTHROPIC_BASE_URL
    if (!baseUrl) return
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN
    const apiKey = getAnthropicApiKey()
    if (!authToken && !apiKey) return

    const url = `${baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(authToken
          ? { Authorization: `Bearer ${authToken}` }
          : apiKey
            ? { 'x-api-key': apiKey }
            : {}),
        'anthropic-version': ANTHROPIC_VERSION,
        'User-Agent': getUserAgent(),
        ...parseGatewayCustomHeaders(),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
      ...getProxyFetchOptions({ url }),
    })
    if (!response.ok) {
      logForDebugging(`[gatewayDiscovery] non-OK status ${response.status}`)
      return
    }
    const body: unknown = await response.json()
    const parsed = z
      .object({ data: z.array(GatewayModelSchema()) })
      .safeParse(body)
    if (!parsed.success) {
      logForDebugging('[gatewayDiscovery] response body failed validation')
      return
    }
    const models: GatewayModel[] = parsed.data.data.filter(model =>
      /^(claude|anthropic)/i.test(model.id),
    )
    if (models.length === 0) {
      logForDebugging('[gatewayDiscovery] 0 usable models after filter')
      return
    }

    const path = getCachePath()
    const existing = loadCache(path)
    if (
      existing &&
      existing.baseUrl === baseUrl &&
      isEqual(existing.models, models)
    ) {
      return
    }

    await mkdir(getCacheDir(), { recursive: true })
    await writeFile(
      path,
      jsonStringify({
        baseUrl,
        fetchedAt: Date.now(),
        models,
      }),
      { encoding: 'utf-8', mode: 0o600 },
    )
    loadCache.cache.delete(path)
    logForDebugging(`[gatewayDiscovery] cached ${models.length} models`)
  } catch (error) {
    logForDebugging(
      `[gatewayDiscovery] fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}
