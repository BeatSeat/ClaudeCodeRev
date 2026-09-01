import { getInitialSettings } from '../settings/settings.js'
import {
  isBashShellAvailable,
  isPowerShellToolEnabled,
} from './shellToolUtils.js'

/**
 * Official 2.1.120 g24: settings.defaultShell, then Windows Git Bash fallback.
 * Linux/macOS keep bash (isBashShellAvailable is always true).
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  const setting = getInitialSettings().defaultShell
  if (setting === 'bash' && !isBashShellAvailable()) return 'powershell'
  if (setting === 'powershell' && !isPowerShellToolEnabled()) return 'bash'
  return setting ?? (isBashShellAvailable() ? 'bash' : 'powershell')
}
