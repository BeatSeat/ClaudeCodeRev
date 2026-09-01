import {
  DEFAULT_GLOBAL_CONFIG,
  getGlobalConfig,
} from '../config.js'
import { getEnabledSettingSources, type SettingSource } from './constants.js'
import { getSettingsForSource, updateSettingsForSource } from './settings.js'
import type { SettingsJson } from './types.js'

/**
 * Official 2.1.119 dSH — /config user-intent keys that persist to
 * ~/.claude/settings.json (userSettings) instead of ~/.claude.json.
 */
export const USER_INTENT_SETTING_KEYS = [
  'theme',
  'editorMode',
  'verbose',
  'preferredNotifChannel',
  'autoCompactEnabled',
  'autoScrollEnabled',
  'fileCheckpointingEnabled',
  'showTurnDuration',
  'showMessageTimestamps',
  'terminalProgressBarEnabled',
  'todoFeatureEnabled',
  'teammateMode',
  'remoteControlAtStartup',
  'autoUploadSessions',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
] as const

export type UserIntentSettingKey = (typeof USER_INTENT_SETTING_KEYS)[number]

export type UserIntentSource = SettingSource | 'legacyGlobalConfig' | 'default'

/**
 * Official 2.1.119 T5 — walk enabled settings sources high→low, then fall
 * back to a non-default ~/.claude.json value for user-intent keys.
 */
export function getUserIntentSettingWithSource<K extends UserIntentSettingKey>(
  key: K,
  defaultValue: SettingsJson[K],
): { value: SettingsJson[K]; source: UserIntentSource } {
  const sources = getEnabledSettingSources()
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]
    if (!source) continue
    const value = getSettingsForSource(source)?.[key]
    if (value !== undefined) {
      return { value: value as SettingsJson[K], source }
    }
  }
  if ((USER_INTENT_SETTING_KEYS as readonly string[]).includes(key)) {
    const legacy = (getGlobalConfig() as Record<string, unknown>)[key]
    const fallback = (DEFAULT_GLOBAL_CONFIG as Record<string, unknown>)[key]
    if (legacy !== undefined && legacy !== fallback) {
      return { value: legacy as SettingsJson[K], source: 'legacyGlobalConfig' }
    }
  }
  return { value: defaultValue, source: 'default' }
}

export function getUserIntentSetting<K extends UserIntentSettingKey>(
  key: K,
  defaultValue: SettingsJson[K],
): SettingsJson[K] {
  return getUserIntentSettingWithSource(key, defaultValue).value
}

/** Official 2.1.119 bL — write one user-intent key to userSettings. */
export function setUserIntentSetting<K extends UserIntentSettingKey>(
  key: K,
  value: SettingsJson[K],
): void {
  updateSettingsForSource('userSettings', { [key]: value } as Partial<SettingsJson>)
}
