import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Official 2.1.119 `C26` / `CZH`.
 * GrowthBook `tengu_slate_meadow` (default false).
 */
export function isAgentViewDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW) ||
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AGENTS_FLEET) ||
    getInitialSettings().disableBackgroundAgents === true
  )
}

/** Official 2.1.139: announced agent view — on unless env/managed disable. */
export function isAgentsFleetEnabled(): boolean {
  return !isAgentViewDisabled()
}

/**
 * Official 2.1.119 `C26` / `bZH`.
 */
export function isFgLeftArrowAgentsAvailable(): boolean {
  return (
    isAgentsFleetEnabled() &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_fg_left_arrow_agents', false)
  )
}

/**
 * Official 2.1.119 `C26` / `qqH` — daemon CLI is shipped off in this release.
 */
export function isDaemonCliEnabled(): boolean {
  return false
}

/**
 * Official 2.1.119 `C26` / `AM$`. Empty while `isDaemonCliEnabled` is false.
 */
export function daemonHint(subcommand: string): string {
  return isDaemonCliEnabled() ? ` — run 'claude daemon ${subcommand}'` : ''
}

/**
 * Official 2.1.119 `C26` / `b_8`.
 */
export function fleetGateRejected(flag: string): never {
  process.stderr.write(`'${flag}' is not available in this release.\n`)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * Official 2.1.119 `rk5`.
 * `claude agents` TTY fast-path only accepts debug flags.
 */
export function isAgentsDebugOnlyArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (
      arg === '--debug' ||
      arg === '-d' ||
      arg === '--debug-to-stderr' ||
      arg === '-d2e' ||
      arg.startsWith('--debug=') ||
      arg.startsWith('--debug-file=')
    ) {
      continue
    }
    if (arg === '--debug-file' && i + 1 < args.length) {
      i++
      continue
    }
    return false
  }
  return true
}
