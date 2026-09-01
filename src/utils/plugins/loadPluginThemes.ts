import type { LoadedPlugin } from '../../types/plugin.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  loadThemesFromDir,
  registerPluginThemes,
  type CustomTheme,
} from '../customThemes.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'

/** Official 2.1.153 `RH` */
function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', {
    feature_name:
      featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Official 2.1.153 `uXz`.
 *
 * For each enabled plugin, load `themesPath` then `themesPaths` via the
 * existing sync parser (`bM6` → `loadThemesFromDir`), register the set
 * (`CM6` → `registerPluginThemes`), and emit `plugin_load_themes`.
 */
export async function loadPluginThemes(
  plugins?: LoadedPlugin[],
): Promise<CustomTheme[]> {
  const enabled = plugins ?? (await loadAllPluginsCacheOnly()).enabled
  const themes: CustomTheme[] = []
  for (const plugin of enabled) {
    const slugPrefix = `${plugin.name}:`
    if (plugin.themesPath) {
      themes.push(...loadThemesFromDir(plugin.themesPath, 'plugin', slugPrefix))
    }
    for (const themePath of plugin.themesPaths ?? []) {
      themes.push(...loadThemesFromDir(themePath, 'plugin', slugPrefix))
    }
  }
  registerPluginThemes(themes)
  featureOk('plugin_load_themes')
  return themes.sort((a, b) => a.name.localeCompare(b.name))
}
