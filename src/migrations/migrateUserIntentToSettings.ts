import { logEvent } from 'src/services/analytics/index.js'
import { DEFAULT_GLOBAL_CONFIG, getGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { USER_INTENT_SETTING_KEYS } from '../utils/settings/userIntent.js'

/**
 * Official 2.1.119 jy4: copy non-default user-intent keys from ~/.claude.json
 * into ~/.claude/settings.json. Skips defaults and keys already set in
 * userSettings. Verbose is one of those keys (#36).
 */
export function migrateUserIntentToSettings(): void {
  const globalConfig = getGlobalConfig() as Record<string, unknown>
  const userSettings = getSettingsForSource('userSettings')
  const pending: Partial<SettingsJson> = {}
  for (const key of USER_INTENT_SETTING_KEYS) {
    const value = globalConfig[key]
    if (value === undefined) continue
    if (value === (DEFAULT_GLOBAL_CONFIG as Record<string, unknown>)[key]) {
      continue
    }
    if (userSettings?.[key] !== undefined) continue
    ;(pending as Record<string, unknown>)[key] = value
  }
  if (Object.keys(pending).length === 0) return
  try {
    updateSettingsForSource('userSettings', pending)
    logEvent('tengu_migrate_user_intent_to_settings', {
      migrated_count: Object.keys(pending).length,
    })
  } catch (error) {
    logError(new Error(`Failed to migrate user-intent settings: ${error}`))
  }
}
