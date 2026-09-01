import type { PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { uniq } from '../array.js'
import {
  formatDependencyCountSuffix,
  formatUnresolvedDependenciesSuffix,
  getEnabledPluginIdsForScope,
} from './dependencyResolver.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  getMarketplaceCacheOnly,
  getPluginById,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from './pluginIdentifier.js'
import { installResolvedPlugin } from './pluginInstallationHelpers.js'
import { loadAllPlugins } from './pluginLoader.js'

const INSTALL_SCOPES = ['user', 'project', 'local'] as const

export type ResolveMissingDependenciesResult = {
  installed: string[]
  stillUnresolved: string[]
  marketplaceMissing: string[]
}

function pickInstallScope(
  declarers: Set<string>,
  enabledByScope: Array<readonly ['user' | 'project' | 'local', Set<string>]>,
): 'user' | 'project' | 'local' {
  for (const [scope, enabled] of enabledByScope) {
    for (const id of declarers) {
      if (enabled.has(id)) return scope
    }
  }
  return 'user'
}

/**
 * Official 2.1.116 `sH8` / 2.1.117 `O$H`: install `dependency-unsatisfied`
 * / `not-found` deps from marketplaces already added. 117 also skips
 * policy-blocked marketplaces and reports `marketplaceMissing` for the
 * "not installed" install hint.
 */
export async function resolveMissingDependencies(
  errors: PluginError[],
): Promise<ResolveMissingDependenciesResult> {
  const declarersByDep = new Map<string, Set<string>>()
  for (const error of errors) {
    if (error.type !== 'dependency-unsatisfied' || error.reason !== 'not-found') {
      continue
    }
    let declarers = declarersByDep.get(error.dependency)
    if (!declarers) {
      declarers = new Set()
      declarersByDep.set(error.dependency, declarers)
    }
    declarers.add(error.source)
  }
  if (declarersByDep.size === 0) {
    return { installed: [], stillUnresolved: [], marketplaceMissing: [] }
  }

  const known = await loadKnownMarketplacesConfig()
  const enabledByScope = INSTALL_SCOPES.map(
    scope =>
      [
        scope,
        getEnabledPluginIdsForScope(scopeToSettingSource(scope)),
      ] as const,
  )
  const installed: string[] = []
  const stillUnresolved: string[] = []
  const marketplaceMissing: string[] = []

  for (const [dep, declarers] of declarersByDep) {
    const marketplace = parsePluginIdentifier(dep).marketplace
    if (!marketplace || !known[marketplace]) {
      stillUnresolved.push(dep)
      marketplaceMissing.push(dep)
      continue
    }
    if (!isSourceAllowedByPolicy(known[marketplace].source)) {
      logForDebugging(
        `resolveMissingDependencies: skipping "${dep}" — marketplace "${marketplace}" is blocked by enterprise policy`,
      )
      stillUnresolved.push(dep)
      continue
    }

    let allowed = false
    for (const declarer of declarers) {
      const from = parsePluginIdentifier(declarer).marketplace
      if (from === marketplace) {
        allowed = true
        break
      }
      if (!from) continue
      const manifest = await getMarketplaceCacheOnly(from)
      if (manifest?.allowCrossMarketplaceDependenciesOn?.includes(marketplace)) {
        allowed = true
        break
      }
    }
    if (!allowed) {
      logForDebugging(
        `resolveMissingDependencies: skipping "${dep}" — cross-marketplace dependency not in any declaring marketplace's allowlist`,
      )
      stillUnresolved.push(dep)
      continue
    }

    try {
      const info = await getPluginById(dep)
      if (!info) {
        stillUnresolved.push(dep)
        continue
      }
      const result = await installResolvedPlugin({
        pluginId: dep,
        entry: info.entry,
        scope: pickInstallScope(declarers, enabledByScope),
        marketplaceInstallLocation: info.marketplaceInstallLocation,
      })
      if (result.ok) {
        for (const id of result.closure) {
          if (!installed.includes(id)) installed.push(id)
        }
      } else {
        logForDebugging(
          `resolveMissingDependencies: install of "${dep}" did not complete (${result.reason})`,
          { level: 'warn' },
        )
        stillUnresolved.push(dep)
      }
    } catch (error) {
      logForDebugging(
        `resolveMissingDependencies: install of "${dep}" threw: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      stillUnresolved.push(dep)
    }
  }

  return { installed, stillUnresolved, marketplaceMissing }
}

/**
 * Official 2.1.117 `emH`: when `plugin install` hits an already-installed
 * plugin, install any missing deps and return a message suffix (or null
 * when there are no unsatisfied-dep errors for this plugin).
 */
export async function installMissingDependenciesForPlugin(
  pluginId: string,
): Promise<{ suffix: string } | null> {
  const { errors } = await loadAllPlugins()
  const forPlugin = errors.filter(
    (error): error is PluginError & { type: 'dependency-unsatisfied' } =>
      error.type === 'dependency-unsatisfied' && error.source === pluginId,
  )
  if (forPlugin.length === 0) return null
  const { installed, marketplaceMissing } =
    await resolveMissingDependencies(forPlugin)
  const installedSet = new Set(installed)
  const stillUnresolved = uniq(forPlugin.map(e => e.dependency)).filter(
    dep => !installedSet.has(dep),
  )
  return {
    suffix: `${formatDependencyCountSuffix(installed)}${formatUnresolvedDependenciesSuffix(stillUnresolved, marketplaceMissing)}`,
  }
}
