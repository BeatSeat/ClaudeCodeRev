import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { logEvent } from '../../services/analytics/index.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { execRelaunchSession } from '../../utils/relaunch.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const RENDERERS = ['default', 'fullscreen'] as const
type Renderer = (typeof RENDERERS)[number]

function currentRenderer(): Renderer {
  return (
    getInitialSettings().tui ??
    (isFullscreenEnvEnabled() ? 'fullscreen' : 'default')
  )
}

export const call: LocalCommandCall = async args => {
  const requested = args.trim().toLowerCase()
  if (requested === '') {
    return {
      type: 'text',
      value: `Current renderer: ${currentRenderer()}. Usage: /tui <${RENDERERS.join('|')}>`,
    }
  }
  if (!(RENDERERS as readonly string[]).includes(requested)) {
    return {
      type: 'text',
      value: `Unknown renderer "${requested}". Usage: /tui <${RENDERERS.join('|')}>`,
    }
  }
  const renderer = requested as Renderer
  const fullscreen = renderer === 'fullscreen'
  if (fullscreen === isFullscreenEnvEnabled()) {
    return { type: 'text', value: `Already using the ${renderer} renderer.` }
  }
  const { error } = updateSettingsForSource('userSettings', { tui: renderer })
  if (error) {
    return { type: 'text', value: `Failed to save setting: ${error.message}` }
  }
  logEvent('tengu_tui_command', { fullscreen })
  await execRelaunchSession({
    freshIfNoTranscript: true,
    env: { CLAUDE_CODE_TUI_JUST_SWITCHED: renderer },
    dropEnv: [
      'CLAUDE_CODE_NO_FLICKER',
      'CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL',
    ],
    sessionId: getSessionId(),
  })
  return { type: 'text', value: `Switching to the ${renderer} renderer…` }
}
