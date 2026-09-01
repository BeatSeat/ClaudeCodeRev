import { logEvent } from '../../services/analytics/index.js'
import { updateSettingsForSource } from '../settings/settings.js'
import type { ModelSetting } from './model.js'

/** Official 2.1.153 `SE$`: persist /model Enter as the default for new sessions. */
export function persistModelAsDefault(model: ModelSetting): void {
  updateSettingsForSource('userSettings', { model: model ?? undefined })
  logEvent('model_set_default', {})
}
