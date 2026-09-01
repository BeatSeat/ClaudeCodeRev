import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isInstallationRelevantToCurrentProject,
  isPluginInstalled,
  loadInstalledPluginsV2,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  getMarketplaceCacheOnly,
  loadKnownMarketplacesConfigSafe,
} from '../../utils/plugins/marketplaceManager.js'
import {
  createPluginId,
  getMarketplaceSourceDisplay,
} from '../../utils/plugins/marketplaceHelpers.js'
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js'
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js'
import type { CommandArgumentCompletion } from '../../types/command.js'

const MARKETPLACE_SUBCOMMANDS: CommandArgumentCompletion[] = [
  { value: 'add', description: 'Add a marketplace from a URL or path' },
  { value: 'remove', description: 'Remove a known marketplace' },
  { value: 'update', description: 'Refresh a marketplace from its source' },
  {
    value: 'list',
    description: 'List known marketplaces',
    isFinal: true,
  },
]

type InstallCandidate = {
  pluginId: string
  description: string | undefined
}

let installCandidatesCache: {
  key: string
  candidates: InstallCandidate[]
} | null = null

/**
 * Official 2.1.157 Zy$: prefix matches first, then substring, casefold.
 */
function filterCompletions(
  items: CommandArgumentCompletion[],
  partial: string,
): CommandArgumentCompletion[] {
  if (!partial) {
    return items
  }
  const q = partial.toLowerCase()
  const prefix: CommandArgumentCompletion[] = []
  const includes: CommandArgumentCompletion[] = []
  for (const item of items) {
    const value = item.value.toLowerCase()
    if (value.startsWith(q)) {
      prefix.push(item)
    } else if (value.includes(q)) {
      includes.push(item)
    }
  }
  return prefix.concat(includes)
}

/**
 * Official 2.1.157 JAz: marketplace install candidates minus already-installed
 * and policy-blocked plugins. Cache key is marketplace name/installLocation/lastUpdated.
 */
async function listInstallCandidates(): Promise<CommandArgumentCompletion[]> {
  const known = await loadKnownMarketplacesConfigSafe()
  const names = Object.keys(known).sort()
  const key = jsonStringify(
    names.map(name => [
      name,
      known[name]?.installLocation,
      known[name]?.lastUpdated,
    ]),
  )
  if (installCandidatesCache?.key !== key) {
    const loaded = await Promise.all(
      names.map(async name => ({
        name,
        marketplace: await getMarketplaceCacheOnly(name),
      })),
    )
    const candidates: InstallCandidate[] = []
    for (const { name, marketplace } of loaded) {
      if (!marketplace) {
        continue
      }
      for (const plugin of marketplace.plugins) {
        candidates.push({
          pluginId: createPluginId(plugin.name, name),
          description: plugin.description,
        })
      }
    }
    candidates.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    installCandidatesCache = { key, candidates }
  }
  return installCandidatesCache.candidates
    .filter(c => !isPluginInstalled(c.pluginId) && !isPluginBlockedByPolicy(c.pluginId))
    .map(c => ({
      value: c.pluginId,
      description: c.description,
      isFinal: true,
    }))
}

/**
 * Official 2.1.157 DAz `getPluginArgumentCompletions`.
 * `completed` is accepted argv tokens; `partial` is the current token.
 */
export async function getPluginArgumentCompletions(
  completed: string[],
  partial: string,
): Promise<CommandArgumentCompletion[]> {
  if (completed.length === 0) {
    return filterCompletions(
      [
        { value: 'enable', description: 'Enable an installed plugin' },
        { value: 'disable', description: 'Disable an installed plugin' },
        { value: 'install', description: 'Install a plugin from a marketplace' },
        { value: 'uninstall', description: 'Remove an installed plugin' },
        { value: 'marketplace', description: 'Manage plugin marketplaces' },
      ],
      partial,
    )
  }

  const cmd = completed[0]?.toLowerCase()
  if (completed.length === 1) {
    switch (cmd) {
      case 'enable':
      case 'disable':
      case 'uninstall': {
        const installed = loadInstalledPluginsV2()
        let entries = Object.entries(installed.plugins).filter(([, insts]) =>
          insts.some(isInstallationRelevantToCurrentProject),
        )
        if (cmd === 'enable' || cmd === 'disable') {
          const enabled = getPluginEditableScopes()
          const wantEnabled = cmd === 'disable'
          entries = entries.filter(([id]) => enabled.has(id) === wantEnabled)
        }
        const items = entries
          .map(([id, insts]) => {
            const version = (
              insts.find(isInstallationRelevantToCurrentProject) ?? insts[0]
            )?.version
            return {
              value: id,
              description: version ? `v${version}` : undefined,
              isFinal: true as const,
            }
          })
          .sort((a, b) => a.value.localeCompare(b.value))
        return filterCompletions(items, partial)
      }
      case 'install':
      case 'i': {
        if (partial.includes('/') || partial.includes('\\')) {
          return []
        }
        return filterCompletions(await listInstallCandidates(), partial)
      }
      case 'marketplace':
      case 'market':
        return filterCompletions(MARKETPLACE_SUBCOMMANDS, partial)
      default:
        return []
    }
  }

  if (
    completed.length === 2 &&
    (cmd === 'marketplace' || cmd === 'market')
  ) {
    const action = completed[1]?.toLowerCase()
    if (action === 'remove' || action === 'rm' || action === 'update') {
      const known = await loadKnownMarketplacesConfigSafe()
      const items = Object.entries(known)
        .map(([name, entry]) => ({
          value: name,
          description: getMarketplaceSourceDisplay(entry.source),
          isFinal: true as const,
        }))
        .sort((a, b) => a.value.localeCompare(b.value))
      return filterCompletions(items, partial)
    }
  }

  return []
}
