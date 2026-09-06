/**
 * Official 2.1.178 Foundry capability strip.
 * `OG6` `wG6` `blK` `MG6` `jG6` `ff8` `xlK` `JW$`.
 */
import { APIError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import { getAPIProvider } from '../../utils/model/providers.js'

const NOT_SUPPORTED_IN_WORKSPACE =
  /([a-z0-9_, ]+?)\s+not supported in your workspace/i
const FEATURES_NOT_AVAILABLE =
  /features are not available for Azure AI Foundry workspaces?:\s*([a-z0-9_, ]+)/i
const SERVER_SIDE_WEB_SEARCH =
  /server-side web search is not available in this environment/i
const CAPABILITY_NAME = /^[a-z][a-z0-9_]*$/
const STRIPPABLE = new Set([
  'tool_search_server',
  'tool_search',
  'structured_outputs',
])

/** Official 2.1.178 `JW$`. */
export const FOUNDRY_PURPOSE_REQUEST_FAIL = 'fail:foundry-purpose-request'

const unsupportedByDeployment = new Map<string, Set<string>>()

/** Official 2.1.178 `OG6`. */
export function getFoundryBaseUrl(): string | undefined {
  return (
    process.env.ANTHROPIC_FOUNDRY_BASE_URL ||
    (process.env.ANTHROPIC_FOUNDRY_RESOURCE
      ? `https://${process.env.ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com`
      : undefined)
  )
}

/** Official 2.1.178 `wG6`. */
function deploymentKey(model: string): string {
  const stripped = model.replace(/\[(1|2)m\]/gi, '')
  return `${getFoundryBaseUrl() ?? 'unknown-foundry-resource'}::${stripped}`
}

/** Official 2.1.178 `blK`. */
export function parseFoundryUnsupportedCapabilities(
  message: string,
): string[] | null {
  const workspace = message.match(NOT_SUPPORTED_IN_WORKSPACE)?.[1]
  if (workspace) {
    const names = workspace.split(',').map(part => part.trim())
    if (names.every(name => CAPABILITY_NAME.test(name))) return names
  }
  const features = message.match(FEATURES_NOT_AVAILABLE)?.[1]
  if (features) {
    const names = features
      .split(/[,\s]+/)
      .filter(part => part !== 'and' && CAPABILITY_NAME.test(part))
    return names.length > 0 ? names : null
  }
  if (SERVER_SIDE_WEB_SEARCH.test(message)) return ['web_search']
  return null
}

/** Official 2.1.178 `MG6`. */
function rememberUnsupported(model: string, names: string[]): void {
  if (names.length === 0) return
  const key = deploymentKey(model)
  const existing = unsupportedByDeployment.get(key)
  if (existing && names.every(name => existing.has(name))) return
  const next = existing ? new Set(existing) : new Set<string>()
  for (const name of names) next.add(name)
  unsupportedByDeployment.set(key, next)
  logForDebugging(
    `[foundry-capabilities] deployment ${key} does not support: ${[...next].join(', ')}`,
    { level: 'warn' },
  )
}

/** Official 2.1.178 `jG6`. */
function parseFoundry400Capabilities(error: unknown): string[] | null {
  if (getAPIProvider() !== 'foundry') return null
  if (!(error instanceof APIError) || error.status !== 400) return null
  const body = error.error
  if (body && typeof body === 'object' && 'error' in body) {
    const inner = (body as { error?: { message?: unknown } }).error
    if (
      inner &&
      typeof inner === 'object' &&
      typeof inner.message === 'string'
    ) {
      return parseFoundryUnsupportedCapabilities(inner.message)
    }
  }
  return parseFoundryUnsupportedCapabilities(error.message ?? '')
}

/**
 * Official 2.1.178 `ff8`.
 * `web_search_tool` → `fail:foundry-purpose-request` (no retry).
 * Strippable caps → `retry:foundry-capability-strip:…`.
 */
export function getFoundryCapabilityRetry(
  error: unknown,
  model: string,
  querySource: string | undefined,
): string | null {
  const names = parseFoundry400Capabilities(error)
  if (!names) return null
  rememberUnsupported(model, names)
  if (querySource === 'web_search_tool') return FOUNDRY_PURPOSE_REQUEST_FAIL
  if (names.some(name => STRIPPABLE.has(name))) {
    return `retry:foundry-capability-strip:${names.join(',')}`
  }
  return null
}

/**
 * Official 2.1.178 `xlK` — drop `defer_loading` / `strict` after a Foundry
 * 400 said tool_search or structured_outputs is unsupported.
 */
export function stripFoundryUnsupportedToolFields<T>(
  tools: T[],
  model: string,
): T[] {
  if (getAPIProvider() !== 'foundry') return tools
  if (unsupportedByDeployment.size === 0) return tools
  const caps = unsupportedByDeployment.get(deploymentKey(model))
  if (!caps || caps.size === 0) return tools
  const stripDefer =
    caps.has('tool_search_server') || caps.has('tool_search')
  const stripStrict = caps.has('structured_outputs')
  if (!stripDefer && !stripStrict) return tools
  let changed = false
  const next = tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool
    const rec = tool as T & {
      defer_loading?: unknown
      strict?: unknown
    }
    const dropDefer = stripDefer && rec.defer_loading
    const dropStrict = stripStrict && rec.strict
    if (!dropDefer && !dropStrict) return tool
    changed = true
    const copy = { ...rec }
    if (dropDefer) delete copy.defer_loading
    if (dropStrict) delete copy.strict
    return copy
  })
  return changed ? next : tools
}
