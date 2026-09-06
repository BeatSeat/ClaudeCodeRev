/**
 * Official 2.1.172 (G3 — tengu_slate_fern): the config-gated plugin-retention
 * window. Net-new in the 2.1.170 → 2.1.172 hop (astdiff added-product cluster
 * `RJA`/`iWq`/`IJA`/`sp9`); the 172 tree had none of it.
 *
 * This is a "re-engage installed-but-idle plugins" feature: when the
 * `tengu_slate_fern` gate is on, a tip surfaces user-installed marketplace
 * plugins that have been unused for ≥ N days AND ≥ M sessions.
 *
 * Minified → readable map (the G3 added-product cluster):
 *   RJA → getSlateFernWindow      (gate reader: null | {days, sessions})
 *   iWq → getDisusedPlugins        (enumerate idle user-installed plugins)
 *   IJA → hasPluginCostComponents  (skip plugins carrying LSP/themes/etc)
 *   sp9 → DEFAULT_DISUSE_DAYS      (14)
 *   tp9 → DEFAULT_DISUSE_SESSIONS  (10)
 *
 * Gate wiring: the sole gate is `tengu_slate_fern` (default false). The gate
 * may be a boolean (true → defaults) or an object {days, sessions} overriding
 * the defaults. `getDisusedPlugins()` is called from the `plugin-disuse-review`
 * tip in the tip registry (both `content` and `isRelevant`).
 *
 * NOTE on the port boundary: `getDisusedPlugins` reads the per-plugin usage
 * record from `getGlobalConfig().pluginUsage` (read via the `U38`-equivalent
 * helper below). The *write-side* recorder for `pluginUsage` is not part of
 * this G3 cluster and is absent from the 172 tree, so until that recorder
 * lands the record is always empty and the tip is inert — which is the
 * faithful 172 state for this hop.
 */

import { getGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getManagedPluginNames } from './managedPlugins.js'
import { getPluginSeedDirs } from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'
import type { LoadedPlugin } from '../../types/plugin.js'

// `sp9` / `tp9` — default retention window.
export const DEFAULT_DISUSE_DAYS = 14
export const DEFAULT_DISUSE_SESSIONS = 10

export type DisuseWindow = {
  days: number
  sessions: number
}

/**
 * Official 2.1.172 `RJA` — read the slate_fern gate.
 *   false (default) → null (feature off)
 *   true            → { days: sp9, sessions: tp9 }
 *   { days?, sessions? } → merge each over the defaults
 */
export function getSlateFernWindow(): DisuseWindow | null {
  const gate = getFeatureValue_CACHED_MAY_BE_STALE<
    | boolean
    | { days?: number; sessions?: number }
    | null
  >('tengu_slate_fern', false)
  if (gate === false) {
    return null
  }
  if (gate === true) {
    return { days: DEFAULT_DISUSE_DAYS, sessions: DEFAULT_DISUSE_SESSIONS }
  }
  return {
    days: typeof gate.days === 'number' ? gate.days : DEFAULT_DISUSE_DAYS,
    sessions:
      typeof gate.sessions === 'number'
        ? gate.sessions
        : DEFAULT_DISUSE_SESSIONS,
  }
}

// `U38` — read one plugin's usage record from the global config.
function getPluginUsageRecord(
  repository: string,
): { usageCount: number; lastUsedAt: number; lastUsedNumStartups: number } | undefined {
  return getGlobalConfig().pluginUsage?.[repository]
}

// `wS6` — classify how a plugin was installed.
type InstallKind = 'default-enable' | 'org-policy' | 'seed-mount' | 'user-install'

function getInstallKind(
  plugin: LoadedPlugin,
  managedNames: Set<string> | null,
  seedDirs: string[],
): InstallKind {
  if (plugin.isBuiltin) {
    return 'default-enable'
  }
  if (managedNames?.has(plugin.name)) {
    return 'org-policy'
  }
  const path = plugin.path
  if (path && seedDirs.some(dir => path.startsWith(dir))) {
    return 'seed-mount'
  }
  return 'user-install'
}

// `IJA` — true when the plugin carries ongoing-cost components (LSP servers,
// themes, output styles, monitors, workflows). Such plugins are skipped by
// getDisusedPlugins (faithful to the bundle's `if (IJA(z)) continue`).
function hasPluginCostComponents(plugin: LoadedPlugin): boolean {
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

// `F38` — derive recency from a usage record.
function computeDisuse(
  usage: { usageCount: number; lastUsedAt: number; lastUsedNumStartups: number },
  numStartups: number,
  now: number,
): { sessionsSinceLastUse: number; daysSinceLastUse: number } {
  return {
    sessionsSinceLastUse: Math.max(0, numStartups - usage.lastUsedNumStartups),
    daysSinceLastUse: Math.max(0, Math.floor((now - usage.lastUsedAt) / 86400000)),
  }
}

export type DisusedPlugin = {
  pluginId: string
  name: string
  daysSinceLastUse: number
}

/**
 * Official 2.1.172 `iWq` — enumerate idle, user-installed, marketplace plugins.
 * Filters: has a marketplace (not inline/skills-dir), install kind is
 * `user-install`, has no ongoing-cost components, has a usage record, and has
 * been unused for ≥ window.days AND ≥ window.sessions. Sorted most-idle first.
 * Returns [] on any error (a disuse tip must never break startup).
 */
export async function getDisusedPlugins(): Promise<DisusedPlugin[]> {
  try {
    const window = getSlateFernWindow()
    if (!window) {
      return []
    }
    const { enabled } = await loadAllPluginsCacheOnly()
    if (enabled.length === 0) {
      return []
    }
    const config = getGlobalConfig()
    const managedNames = getManagedPluginNames()
    const seedDirs = getPluginSeedDirs()
    const now = Date.now()
    const disused: DisusedPlugin[] = []
    for (const plugin of enabled) {
      const { marketplace } = parsePluginIdentifier(plugin.repository)
      // Skip inline / skills-dir sources (`hv`).
      if (!marketplace || marketplace === 'inline' || marketplace === 'skills-dir') {
        continue
      }
      if (getInstallKind(plugin, managedNames, seedDirs) !== 'user-install') {
        continue
      }
      if (hasPluginCostComponents(plugin)) {
        continue
      }
      const usage = getPluginUsageRecord(plugin.repository)
      if (!usage) {
        continue
      }
      const { sessionsSinceLastUse, daysSinceLastUse } = computeDisuse(
        usage,
        config.numStartups,
        now,
      )
      if (daysSinceLastUse >= window.days && sessionsSinceLastUse >= window.sessions) {
        disused.push({
          pluginId: plugin.repository,
          name: plugin.name,
          daysSinceLastUse,
        })
      }
    }
    disused.sort((a, b) => b.daysSinceLastUse - a.daysSinceLastUse)
    return disused
  } catch (error) {
    logForDebugging(
      `plugin-disuse tip: failed to compute disused plugins: ${error}`,
      { level: 'error' },
    )
    return []
  }
}
