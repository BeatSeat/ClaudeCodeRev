import { capitalize } from './stringUtils.js'

/**
 * Official 2.1.169 `UJ` — fragment naming how to turn safe mode off, used by
 * the safe-mode notices (themes, output styles, keybindings, memory, status
 * banner). The wording depends on HOW safe mode was enabled: `--safe-mode`
 * reads differently from the CLAUDE_CODE_SAFE_MODE env var.
 *
 * Mirrors the bundle's `bF$` flag check: only argv before a bare `--`
 * separator counts, so `claude -- echo --safe-mode` doesn't false-positive.
 *
 * Stopgap: the shared safe-mode plumbing (isSafeMode & friends) is owned by
 * the core 2.1.169 landing in src/bootstrap/state.ts — dedupe onto its hint
 * export when it exists.
 */
export function getSafeModeOffHint(): string {
  const separator = process.argv.indexOf('--')
  const flags = separator === -1 ? process.argv : process.argv.slice(0, separator)
  return flags.includes('--safe-mode')
    ? 'restart without --safe-mode'
    : 'unset CLAUDE_CODE_SAFE_MODE'
}

/**
 * Official 2.1.169 — the dim "… to re-enable" tail line under the safe-mode
 * status banner (bundle `e2(UJ())`).
 */
export function getSafeModeReEnableHint(): string {
  return `${capitalize(getSafeModeOffHint())} to re-enable`
}
