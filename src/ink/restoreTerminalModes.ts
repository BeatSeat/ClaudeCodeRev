import { writeSync } from 'fs'
import { logForDebugging } from 'src/utils/debug.js'
import { isErrnoException } from 'src/utils/errors.js'
import { RESET_G0_USASCII, RESTORE_CURSOR, SAVE_CURSOR } from './termio/ansi.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  RESET_SCROLL_REGION,
} from './termio/csi.js'
import { DBP, DFE, DTHEME, SHOW_CURSOR } from './termio/dec.js'
import { isProgressReportingAvailable } from './terminal.js'
import { CLEAR_ITERM2_PROGRESS } from './termio/osc.js'

/**
 * Official `s48` / 160 `x78`. Shared terminal-mode reset used by Ink unmount
 * and gracefulShutdown. 2.1.161 wraps the writes so a dead TTY (numeric
 * errno) logs instead of throwing.
 */
export function restoreTerminalModes(): void {
  /* eslint-disable custom-rules/no-sync-fs -- must flush before process.exit */
  try {
    writeSync(1, RESET_G0_USASCII)
    writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
    writeSync(1, DISABLE_KITTY_KEYBOARD)
    writeSync(1, DFE)
    writeSync(1, DTHEME)
    writeSync(1, DBP)
    writeSync(1, SHOW_CURSOR)
    writeSync(1, SAVE_CURSOR + RESET_SCROLL_REGION + RESTORE_CURSOR)
    if (isProgressReportingAvailable()) {
      writeSync(1, CLEAR_ITERM2_PROGRESS)
    }
  } catch (error) {
    if (isErrnoException(error)) {
      logForDebugging(`restoreTerminalModes writeSync failed: ${error}`, {
        level: 'error',
      })
    } else {
      throw error
    }
  }
  /* eslint-enable custom-rules/no-sync-fs */
}
