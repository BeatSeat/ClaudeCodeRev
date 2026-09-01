import { getSdkBetas } from '../../bootstrap/state.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  formatAutoCompactWindowStatus,
  resolveAutoCompactWindow,
  setAutoCompactWindowFromArg,
} from '../../utils/autoCompactWindow.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async args => {
  const model = getMainLoopModel()
  const modelWindow = getContextWindowForModel(model, getSdkBetas())
  const trimmed = args.trim()
  if (!trimmed) {
    const settingsWindow = isAutoCompactEnabled()
      ? getInitialSettings().autoCompactWindow
      : undefined
    return {
      type: 'text',
      value: formatAutoCompactWindowStatus(
        resolveAutoCompactWindow(modelWindow, settingsWindow),
        isAutoCompactEnabled(),
      ),
    }
  }
  return {
    type: 'text',
    value: setAutoCompactWindowFromArg(trimmed, modelWindow),
  }
}
