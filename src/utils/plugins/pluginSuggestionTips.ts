/**
 * Official 2.1.152 marketplace plugin suggestion tips.
 *
 * `N17` — policySettings.pluginSuggestionMarketplaces
 * `E17` — registered source must also be declared in managed settings
 * `WNz` — build spinner tips from marketplace.json `relevance` signals
 * `NR8` — tip relevance (cli / hosts / filePath / manifestDeps)
 */

import isEqual from 'lodash-es/isEqual.js'
import { color } from '../../components/design-system/color.js'
import type { Tip, TipContext } from '../../services/tips/types.js'
import { logForDebugging } from '../debug.js'
import { cacheKeys, type FileStateCache } from '../fileStateCache.js'
import { getFsImplementation } from '../fsOperations.js'
import { getSettingsForSource } from '../settings/settings.js'
import { withTimeout } from '../sleep.js'
import { isPluginInstalled } from './installedPluginsManager.js'
import { extractHostFromSource } from './marketplaceHelpers.js'
import {
  getMarketplaceCacheOnly,
  loadKnownMarketplacesConfigSafe,
  type KnownMarketplacesConfig,
} from './marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from './officialMarketplace.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'
import type { MarketplaceSource, PluginMarketplaceEntry } from './schemas.js'

const MANIFEST_DEP_MAX_BYTES = 524288
const MANIFEST_DEP_SCAN_TIMEOUT_MS = 50

/** Official 2.1.152 `JX` — official marketplace name constant. */
export const PLUGIN_SUGGESTION_OFFICIAL_MARKETPLACE = OFFICIAL_MARKETPLACE_NAME

export type PluginSuggestionSignals = {
  cli?: string[]
  hosts?: string[]
  filePath?: RegExp
  manifestDep?: Array<{ file: RegExp; pattern: RegExp }>
}

type MarketplacePluginWithRelevance = PluginMarketplaceEntry & {
  relevance?: {
    topic?: string
    signals?: {
      cli?: string[]
      hosts?: string[]
      filePath?: string
      manifestDeps?: Array<{ file: string; pattern: string }>
    }
  }
}

let knownMarketplacesCache: KnownMarketplacesConfig | undefined
let marketplaceTipsCache: Tip[] | undefined

/** Official 2.1.152 `JO9` — memoized known_marketplaces.json. */
async function loadKnownMarketplacesCached(): Promise<KnownMarketplacesConfig> {
  if (knownMarketplacesCache !== undefined) {
    return knownMarketplacesCache
  }
  knownMarketplacesCache = await loadKnownMarketplacesConfigSafe()
  return knownMarketplacesCache
}

/**
 * Official 2.1.152 `N17`.
 * Policy-scope only — user/project/local settings ignore this key.
 */
export function getPluginSuggestionMarketplaces(): string[] {
  return (
    getSettingsForSource('policySettings')?.pluginSuggestionMarketplaces ?? []
  )
}

/** Official 2.1.152 `y17`. */
function areSourcesEqual(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.source !== b.source) return false

  switch (a.source) {
    case 'url':
      return a.url === (b as typeof a).url
    case 'github':
      return (
        a.repo === (b as typeof a).repo &&
        (a.ref || undefined) === ((b as typeof a).ref || undefined) &&
        (a.path || undefined) === ((b as typeof a).path || undefined)
      )
    case 'git':
      return (
        a.url === (b as typeof a).url &&
        (a.ref || undefined) === ((b as typeof a).ref || undefined) &&
        (a.path || undefined) === ((b as typeof a).path || undefined)
      )
    case 'npm':
      return a.package === (b as typeof a).package
    case 'file':
      return a.path === (b as typeof a).path
    case 'directory':
      return a.path === (b as typeof a).path
    case 'settings':
      return (
        a.name === (b as typeof a).name &&
        isEqual(a.plugins, (b as typeof a).plugins)
      )
    default:
      return false
  }
}

/** Official 2.1.152 `h17`. */
function matchesHostPattern(
  source: MarketplaceSource,
  pattern: MarketplaceSource & { source: 'hostPattern' },
): boolean {
  const host = extractHostFromSource(source)
  if (!host) return false
  try {
    return new RegExp(pattern.hostPattern).test(host)
  } catch {
    logForDebugging(
      `Invalid hostPattern regex in policy settings: ${pattern.hostPattern}`,
      { level: 'error' },
    )
    return false
  }
}

/** Official 2.1.152 `S17`. */
function matchesPathPattern(
  source: MarketplaceSource,
  pattern: MarketplaceSource & { source: 'pathPattern' },
): boolean {
  if (source.source !== 'file' && source.source !== 'directory') {
    return false
  }
  try {
    return new RegExp(pattern.pathPattern).test(source.path)
  } catch {
    logForDebugging(
      `Invalid pathPattern regex in policy settings strictKnownMarketplaces: ${pattern.pathPattern}`,
      { level: 'error' },
    )
    return false
  }
}

/** Official 2.1.152 `I17`. */
function matchesStrictAllowlistEntry(
  registered: MarketplaceSource,
  entry: MarketplaceSource,
): boolean {
  if (entry.source === 'hostPattern') {
    return matchesHostPattern(registered, entry)
  }
  if (entry.source === 'pathPattern') {
    return matchesPathPattern(registered, entry)
  }
  if (entry.source === 'skills-dir') {
    return false
  }
  return areSourcesEqual(registered, entry)
}

/**
 * Official 2.1.152 `E17`.
 * A non-official marketplace name only takes effect when its registered
 * source is also declared in managed settings (extraKnownMarketplaces entry
 * or a matching strictKnownMarketplaces allowlist item).
 */
export function isMarketplaceSourceDeclaredInManagedSettings(
  name: string,
  registeredSource: MarketplaceSource,
): boolean {
  const policy = getSettingsForSource('policySettings')
  const extraSource = policy?.extraKnownMarketplaces?.[name]?.source
  if (extraSource && areSourcesEqual(registeredSource, extraSource)) {
    return true
  }
  return (
    policy?.strictKnownMarketplaces?.some(entry =>
      matchesStrictAllowlistEntry(registeredSource, entry),
    ) ?? false
  )
}

function titleCaseHyphenated(name: string): string {
  return name
    .split('-')
    .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('-')
}

async function scanManifestDeps(
  readFileState: FileStateCache,
  readFiles: string[],
  manifestDep: Array<{ file: RegExp; pattern: RegExp }>,
): Promise<boolean> {
  const entries = new Map(readFileState.entries())
  const fs = getFsImplementation()
  for (const { file, pattern } of manifestDep) {
    for (const path of readFiles) {
      if (!file.test(path)) continue
      try {
        const cached = entries.get(path)
        let content =
          cached &&
          cached.limit === undefined &&
          (cached.offset ?? 1) <= 1 &&
          !cached.isPartialView
            ? cached.content
            : undefined
        if (!content) {
          if ((await fs.stat(path)).size > MANIFEST_DEP_MAX_BYTES) continue
          content = await fs.readFile(path, { encoding: 'utf8' })
        }
        if (pattern.test(content)) return true
      } catch {
        // skip unreadable files
      }
    }
  }
  return false
}

/**
 * Official 2.1.152 `NR8`.
 * Marketplace must be registered; plugin must not already be installed or
 * policy-blocked. Then match cli / hosts / filePath / manifestDeps.
 */
export async function isMarketplacePluginRelevant(
  pluginName: string,
  context: TipContext | undefined,
  signals: PluginSuggestionSignals,
  marketplaceName: string = OFFICIAL_MARKETPLACE_NAME,
): Promise<boolean> {
  const known = await loadKnownMarketplacesCached()
  if (!known[marketplaceName]) {
    return false
  }
  const pluginId = `${pluginName}@${marketplaceName}`
  if (isPluginInstalled(pluginId)) {
    return false
  }
  if (isPluginBlockedByPolicy(pluginId)) {
    return false
  }

  const { bashTools, bashHosts } = context ?? {}
  if (signals.cli && bashTools?.size) {
    if (signals.cli.some(cmd => bashTools.has(cmd))) {
      return true
    }
  }
  if (signals.hosts?.length && bashHosts?.size) {
    if (signals.hosts.some(host => bashHosts.has(host))) {
      return true
    }
  }

  const readFileState = context?.readFileState
  const readFiles = readFileState ? cacheKeys(readFileState) : []
  if (signals.filePath && readFiles.some(fp => signals.filePath!.test(fp))) {
    return true
  }
  if (signals.manifestDep && readFileState && readFiles.length > 0) {
    const hit = await withTimeout(
      scanManifestDeps(readFileState, readFiles, signals.manifestDep),
      MANIFEST_DEP_SCAN_TIMEOUT_MS,
      'manifestDep scan',
    ).catch(() => false)
    if (hit) return true
  }
  return false
}

/**
 * Official 2.1.152 `WNz`.
 * Always includes the official marketplace; policySettings names are additive.
 * Non-official names are skipped unless `E17` confirms the registered source
 * is declared in managed settings.
 */
export async function getMarketplacePluginSuggestionTips(
  hardcodedTips: readonly Tip[] = [],
): Promise<Tip[]> {
  if (marketplaceTipsCache !== undefined) {
    return marketplaceTipsCache
  }

  const names = new Set([
    OFFICIAL_MARKETPLACE_NAME,
    ...getPluginSuggestionMarketplaces(),
  ])
  const known = await loadKnownMarketplacesCached()
  const tips: Tip[] = []

  for (const marketplaceName of names) {
    const registered = known[marketplaceName]
    if (!registered) continue
    if (
      marketplaceName !== OFFICIAL_MARKETPLACE_NAME &&
      !isMarketplaceSourceDeclaredInManagedSettings(
        marketplaceName,
        registered.source,
      )
    ) {
      logForDebugging(
        `Skipping plugin suggestion tips for marketplace "${marketplaceName}": its registered source is not declared in managed settings (extraKnownMarketplaces or strictKnownMarketplaces)`,
      )
      continue
    }

    const marketplace = await getMarketplaceCacheOnly(marketplaceName).catch(
      () => null,
    )
    if (!marketplace) continue

    for (const plugin of marketplace.plugins as MarketplacePluginWithRelevance[]) {
      const relevance = plugin.relevance
      const rawSignals = relevance?.signals
      if (
        !rawSignals ||
        (!rawSignals.cli?.length &&
          !rawSignals.filePath &&
          !rawSignals.manifestDeps?.length &&
          !rawSignals.hosts?.length)
      ) {
        continue
      }

      let filePath: RegExp | undefined
      let manifestDep: Array<{ file: RegExp; pattern: RegExp }> | undefined
      try {
        if (rawSignals.filePath) {
          filePath = new RegExp(rawSignals.filePath, 'i')
        }
        if (rawSignals.manifestDeps?.length) {
          manifestDep = rawSignals.manifestDeps.map(dep => ({
            file: new RegExp(dep.file, 'i'),
            pattern: new RegExp(dep.pattern),
          }))
        }
      } catch (error) {
        logForDebugging(
          `Skipping marketplace tip for "${plugin.name}": invalid RegExp in relevance.signals: ${error}`,
          { level: 'warn' },
        )
        continue
      }

      if (
        marketplaceName === OFFICIAL_MARKETPLACE_NAME &&
        hardcodedTips.some(tip => tip.id === `${plugin.name}-plugin`)
      ) {
        continue
      }

      const hosts = rawSignals.hosts?.map(host => host.toLowerCase())
      const signals: PluginSuggestionSignals = {
        cli: rawSignals.cli,
        hosts,
        filePath,
        manifestDep,
      }
      const topic = relevance?.topic ?? titleCaseHyphenated(plugin.name)
      const id =
        marketplaceName === OFFICIAL_MARKETPLACE_NAME
          ? `marketplace-plugin:${plugin.name}`
          : `marketplace-plugin:${plugin.name}@${marketplaceName}`

      tips.push({
        id,
        priority: 1,
        providerAgnostic: true,
        cooldownSessions: 3,
        content: async ctx => {
          const suggestion = color('suggestion', ctx.theme)
          return `Working with ${topic}? Install the ${plugin.name} plugin:\n${suggestion(`/plugin install ${plugin.name}@${marketplaceName}`)}`
        },
        isRelevant: async ctx =>
          isMarketplacePluginRelevant(
            plugin.name,
            ctx,
            signals,
            marketplaceName,
          ),
      })
    }
  }

  marketplaceTipsCache = tips
  return marketplaceTipsCache
}
