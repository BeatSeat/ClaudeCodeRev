import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Runtime gate for PowerShellTool. Official 2.1.111 `ly6`:
 * - Linux/macOS: on only when CLAUDE_CODE_USE_POWERSHELL_TOOL is truthy
 *   (requires `pwsh` on PATH at execution time).
 * - Windows: env=1 forces on, env=0 forces off, unset → tengu_cobalt_ridge
 *   progressive rollout (default off).
 *
 * Used by tools.ts (tool-list visibility), processBashCommand (! routing),
 * and promptShellExecution (skill frontmatter routing) so the gate is
 * consistent across all paths that invoke PowerShellTool.call().
 */
export function isPowerShellToolEnabled(): boolean {
  const env = process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
  if (getPlatform() !== 'windows') return isEnvTruthy(env)
  if (isEnvTruthy(env)) return true
  if (isEnvDefinedFalsy(env)) return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_ridge', false)
}
