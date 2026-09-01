import type { LocalCommandCall } from '../../types/command.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'

/**
 * Official 2.1.110 qaK — local (non-JSX) /exit for Remote Control.
 * Ink ExitFlow is local-jsx and blocked on the bridge; this counterpart
 * just shuts down the REPL.
 */
export const call: LocalCommandCall = async () => {
  await gracefulShutdown(0, 'prompt_input_exit')
  return { type: 'skip' }
}
