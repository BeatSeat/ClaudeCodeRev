import { getSettingsForSource } from '../settings/settings.js'

/**
 * Plugin names locked by org policy (policySettings.enabledPlugins).
 *
 * Returns null when managed settings declare no plugin entries (common
 * case — no policy in effect).
 */
export function getManagedPluginNames(): Set<string> | null {
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  if (!enabledPlugins) {
    return null
  }
  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // Only plugin@marketplace boolean entries (true OR false) are
    // protected. Legacy owner/repo array form is not.
    if (typeof value !== 'boolean' || !pluginId.includes('@')) {
      continue
    }
    const name = pluginId.split('@')[0]
    if (name) {
      names.add(name)
    }
  }
  return names.size > 0 ? names : null
}

/**
 * Official 2.1.101 eC6: force-enabled managed plugins (`plugin@marketplace: true`).
 * SessionStart skips plugin-hook load only when allowManagedHooksOnly is set
 * AND this returns null.
 */
export function getForceEnabledManagedPluginIds(): Set<string> | null {
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  if (!enabledPlugins) {
    return null
  }
  const ids = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    if (value === true && pluginId.includes('@')) {
      ids.add(pluginId)
    }
  }
  return ids.size > 0 ? ids : null
}
