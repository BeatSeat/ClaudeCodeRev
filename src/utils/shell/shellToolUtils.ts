import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'
import { findGitBashPath } from '../windowsPaths.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Official 2.1.120 B4: bash runtime is always available off Windows.
 * On Windows it is true only when Git Bash was found.
 */
export function isBashShellAvailable(): boolean {
  if (getPlatform() !== 'windows') return true
  return findGitBashPath() !== null
}

/**
 * Runtime gate for PowerShellTool. Official 2.1.120 `_b`:
 * - Linux/macOS: on only when CLAUDE_CODE_USE_POWERSHELL_TOOL is truthy.
 * - Windows: env=0 forces off, env=1 forces on, missing Git Bash → on,
 *   else tengu_cobalt_ridge (default off).
 *
 * Do not enable PowerShell on Linux by default.
 */
export function isPowerShellToolEnabled(): boolean {
  const env = process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
  if (getPlatform() !== 'windows') return isEnvTruthy(env)
  if (isEnvDefinedFalsy(env)) return false
  if (isEnvTruthy(env)) return true
  if (findGitBashPath() === null) return true
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_ridge', false)
}
