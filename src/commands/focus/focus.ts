import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<null> {
  const next = !context.getAppState().briefTranscript
  context.setAppState(prev =>
    prev.briefTranscript === next ? prev : { ...prev, briefTranscript: next },
  )
  if (getGlobalConfig().briefTranscript !== next) {
    saveGlobalConfig(prev => ({ ...prev, briefTranscript: next }))
  }
  onDone(next ? 'Focus view enabled' : 'Focus view disabled', {
    display: 'system',
  })
  return null
}
