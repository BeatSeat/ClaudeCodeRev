import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getSystemPromptSectionCache } from '../../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

const FULLSCREEN_RENDERER_HINT =
  'Focus view needs the fullscreen renderer. Run /tui fullscreen to switch (this restarts and resumes your session), or set CLAUDE_CODE_NO_FLICKER=1 and restart.'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<null> {
  if (!isFullscreenEnvEnabled()) {
    if (getInitialSettings().viewMode === 'focus') {
      onDone(
        `Focus view is set by "viewMode": "focus" in settings.json \u2014 remove it there and restart Claude Code to turn it off. ${FULLSCREEN_RENDERER_HINT}`,
        { display: 'system' },
      )
      return null
    }
    if (
      context.getAppState().briefTranscript ||
      getGlobalConfig().briefTranscript
    ) {
      context.setAppState(prev =>
        prev.briefTranscript ? { ...prev, briefTranscript: false } : prev,
      )
      if (getGlobalConfig().briefTranscript) {
        saveGlobalConfig(prev => ({ ...prev, briefTranscript: false }))
      }
      getSystemPromptSectionCache().delete('focus_mode')
      onDone(`Focus view disabled. ${FULLSCREEN_RENDERER_HINT}`, {
        display: 'system',
      })
      return null
    }
    onDone(FULLSCREEN_RENDERER_HINT, { display: 'system' })
    return null
  }

  const next = !context.getAppState().briefTranscript
  context.setAppState(prev =>
    prev.briefTranscript === next ? prev : { ...prev, briefTranscript: next },
  )
  if (getGlobalConfig().briefTranscript !== next) {
    saveGlobalConfig(prev => ({ ...prev, briefTranscript: next }))
  }
  getSystemPromptSectionCache().delete('focus_mode')
  onDone(next ? 'Focus view enabled' : 'Focus view disabled', {
    display: 'system',
  })
  return null
}
