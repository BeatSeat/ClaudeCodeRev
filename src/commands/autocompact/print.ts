import { getSdkBetas } from '../../bootstrap/state.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  formatAutoCompactWindowStatus,
  resolveAutoCompactWindow,
  setAutoCompactWindowFromArg,
} from '../../utils/autoCompactWindow.js'
import { getContextWindowForModel } from '../../utils/context.js'

export const call: LocalCommandCall = async (args, context) => {
  const trimmed = args.trim()
  if (!trimmed) {
    const modelWindow = getContextWindowForModel(
      context.options.mainLoopModel,
      getSdkBetas(),
    )
    const settingsWindow = context.getAppState().autoCompactWindow
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
    value: setAutoCompactWindowFromArg(trimmed, context),
  }
}
