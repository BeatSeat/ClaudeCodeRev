import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const focus = {
  type: 'local-jsx',
  name: 'focus',
  description:
    'Toggle focus view (show only your prompt, a tool summary, and the final response)',
  isEnabled: isFullscreenEnvEnabled,
  immediate: true,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
