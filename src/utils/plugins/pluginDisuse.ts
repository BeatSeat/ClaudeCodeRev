/**
 * Official 2.1.187 `xVt` — plugins unused long enough to tip about /plugin review.
 *
 * Thresholds: ≥14 days AND ≥10 sessions since last use (`Pof`/`Mof`).
 */

import type { LoadedPlugin } from '../../types/plugin.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getStrictKnownMarketplaces } from './marketplaceHelpers.js'
import { getManagedPluginNames } from './managedPlugins.js'
import { getPluginSeedDirs } from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'
import { getEnabledVia } from '../telemetry/pluginTelemetry.js'

/** Official 2.1.187 `Pof`. */
const DISUSE_MIN_DAYS = 14
/** Official 2.1.187 `Mof`. */
const DISUSE_MIN_SESSIONS = 10

export type DisusedPlugin = {
  pluginId: string
  name: string
  daysSinceLastUse: number
}

type PluginUsageEntry = {
  usageCount: number
  lastUsedAt: number
  lastUsedNumStartups: number
}

/** Official 2.1.187 `GPt`. */
export function getPluginUsageEntry(
  pluginId: string,
): PluginUsageEntry | undefined {
  return getGlobalConfig().pluginUsage?.[pluginId]
}

/** Official 2.1.187 `WPt`. */
export function computePluginUsageAge(
  entry: PluginUsageEntry,
  numStartups: number,
  now: number,
): { sessionsSinceLastUse: number; daysSinceLastUse: number } {
  return {
    sessionsSinceLastUse: Math.max(0, numStartups - entry.lastUsedNumStartups),
    daysSinceLastUse: Math.max(
      0,
      Math.floor((now - entry.lastUsedAt) / 86400000),
    ),
  }
}

/**
 * Official 2.1.187 `$of` — plugins that contribute always-on surfaces
 * (LSP / themes / output styles / monitors / workflows) are not "unused".
 */
export function pluginHasAlwaysOnSurfaces(plugin: LoadedPlugin): boolean {
  const withWorkflows = plugin as LoadedPlugin & {
    workflowsPath?: string
    workflowsPaths?: string[]
  }
  return Boolean(
    (plugin.lspServers && Object.keys(plugin.lspServers).length > 0) ||
      plugin.themesPath ||
      plugin.themesPaths?.length ||
      plugin.outputStylesPath ||
      plugin.outputStylesPaths?.length ||
      plugin.monitors?.length ||
      withWorkflows.workflowsPath ||
      withWorkflows.workflowsPaths?.length,
  )
}

/** Official 2.1.187 `E0` — skip virtual inline / skills-dir marketplaces. */
function isVirtualMarketplace(marketplace: string | undefined): boolean {
  return marketplace === 'inline' || marketplace === 'skills-dir'
}

/**
 * Official 2.1.187 `Dwn` — seed usage rows for newly enabled plugins so
 * disuse age starts from first enable, not from missing data.
 */
export function seedPluginUsageEntries(pluginIds: string[]): void {
  if (pluginIds.length === 0) return
  const now = Date.now()
  saveGlobalConfig(current => {
    const missing = pluginIds.filter(id => !current.pluginUsage?.[id])
    if (missing.length === 0) return current
    const pluginUsage = { ...current.pluginUsage }
    for (const id of missing) {
      pluginUsage[id] = {
        usageCount: 0,
        lastUsedAt: now,
        lastUsedNumStartups: current.numStartups,
      }
    }
    return { ...current, pluginUsage }
  })
}

/**
 * Official 2.1.187 `xVt`.
 * Returns [] when plugins aren't cached yet, or managed marketplace lockdown
 * (`strictKnownMarketplaces`) is active.
 */
export async function getDisusedPlugins(): Promise<DisusedPlugin[]> {
  try {
    if (!loadAllPluginsCacheOnly.cache?.has(undefined)) {
      return []
    }
    if (getStrictKnownMarketplaces() !== null) {
      return []
    }
    const { enabled } = await loadAllPluginsCacheOnly()
    if (enabled.length === 0) return []

    const managedNames = getManagedPluginNames()
    const seedDirs = getPluginSeedDirs()
    const numStartups = getGlobalConfig().numStartups
    const now = Date.now()
    const result: DisusedPlugin[] = []

    for (const plugin of enabled) {
      const { marketplace } = parsePluginIdentifier(plugin.repository)
      if (!marketplace || isVirtualMarketplace(marketplace)) continue
      if (getEnabledVia(plugin, managedNames, seedDirs) !== 'user-install') {
        continue
      }
      if (pluginHasAlwaysOnSurfaces(plugin)) continue
      const usage = getPluginUsageEntry(plugin.repository)
      if (!usage) continue
      const { sessionsSinceLastUse, daysSinceLastUse } = computePluginUsageAge(
        usage,
        numStartups,
        now,
      )
      if (
        daysSinceLastUse >= DISUSE_MIN_DAYS &&
        sessionsSinceLastUse >= DISUSE_MIN_SESSIONS
      ) {
        result.push({
          pluginId: plugin.repository,
          name: plugin.name,
          daysSinceLastUse,
        })
      }
    }

    return result.sort((a, b) => b.daysSinceLastUse - a.daysSinceLastUse)
  } catch (err) {
    logForDebugging(
      `plugin-disuse tip: failed to compute disused plugins: ${err}`,
      { level: 'error' },
    )
    return []
  }
}
