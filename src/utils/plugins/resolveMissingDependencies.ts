import type { PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { getEnabledPluginIdsForScope } from './dependencyResolver.js'
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

const INSTALL_SCOPES = ['user', 'project', 'local'] as const

export type ResolveMissingDependenciesResult = {
  installed: string[]
  stillUnresolved: string[]
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
 * Official 2.1.116 `sH8`: install `dependency-unsatisfied` / `not-found`
 * deps from marketplaces already added. Used by `/reload-plugins` and
 * background plugin autoupdate.
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
    return { installed: [], stillUnresolved: [] }
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

  for (const [dep, declarers] of declarersByDep) {
    const marketplace = parsePluginIdentifier(dep).marketplace
    if (!marketplace || !known[marketplace]) {
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

  return { installed, stillUnresolved }
}
