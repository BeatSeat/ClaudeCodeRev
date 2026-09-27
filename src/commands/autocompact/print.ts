import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  formatAutoCompactWindowStatus,
  resolveAutoCompactWindow,
  setAutoCompactWindowFromArg,
} from '../../utils/autoCompactWindow.js'

export const call: LocalCommandCall = async (args, context) => {
  const trimmed = args.trim()
  if (!trimmed) {
    const settingsWindow = context.getAppState().autoCompactWindow
    return {
      type: 'text',
      value: formatAutoCompactWindowStatus(
        resolveAutoCompactWindow(context.options.mainLoopModel, settingsWindow),
        isAutoCompactEnabled(),
      ),
    }
  }
  return {
    type: 'text',
    value: setAutoCompactWindowFromArg(trimmed, context),
  }
}
