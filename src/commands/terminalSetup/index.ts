import type { Command } from '../../commands.js'
import { env } from '../../utils/env.js'

// Official 121 mq5 — iTerm2 is no longer hidden so /terminal-setup can
// enable AllowClipboardAccess for /copy. Shift+Enter is still native.
const HIDDEN_NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  WezTerm: 'WezTerm',
}

function isITerm2ClipboardSetup(): boolean {
  return (
    process.env.__CFBundleIdentifier === 'com.googlecode.iterm2' &&
    (env.terminal === 'iTerm.app' ||
      env.terminal === 'tmux' ||
      env.terminal === 'screen' ||
      env.terminal === null)
  )
}

const terminalSetup = {
  type: 'local-jsx',
  name: 'terminal-setup',
  get description() {
    if (env.terminal === 'Apple_Terminal') {
      return 'Enable Option+Enter key binding for newlines and visual bell'
    }
    if (isITerm2ClipboardSetup()) {
      return 'Enable iTerm2 clipboard access for /copy'
    }
    return 'Install Shift+Enter key binding for newlines'
  },
  isHidden:
    env.terminal !== null && env.terminal in HIDDEN_NATIVE_CSIU_TERMINALS,
  load: () => import('./terminalSetup.js'),
} satisfies Command

export default terminalSetup
