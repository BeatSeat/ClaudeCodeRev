import { createSignal } from '../signal.js'
import type { SettingSource } from './constants.js'
import { resetSettingsCache } from './settingsCache.js'

const settingsChanged = createSignal<[source: SettingSource]>()

/**
 * Publish a settings snapshot change from either an external watcher or an
 * in-process write. Cache invalidation is centralized here so every listener
 * observes the same freshly loaded snapshot.
 */
export function publishSettingsChange(source: SettingSource): void {
  resetSettingsCache()
  settingsChanged.emit(source)
}

export const subscribeToSettingsChanges = settingsChanged.subscribe

export function clearSettingsChangeSubscribers(): void {
  settingsChanged.clear()
}
