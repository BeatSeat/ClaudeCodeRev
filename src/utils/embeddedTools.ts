import { execFileSync } from 'node:child_process'
import { isEnvTruthy } from './envUtils.js'
import { getSearchToolsOptIn } from '../bootstrap/state.js'

type DpBinGlobal = typeof globalThis & { __dpBinOk?: boolean }

/**
 * Whether this build has bfs/ugrep embedded in the bun binary (ant-native only).
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that invoke the bun binary with argv0='bfs' / argv0='ugrep' (same trick
 *   as embedded ripgrep)
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 *
 * Set as a build-time define in scripts/build-with-plugins.ts for ant-native builds.
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  // Official 2.1.165 LP: probe for the bfs/ugrep shims on PATH once and
  // cache the result. Cometix builds don't embed the binaries, so the probe
  // fails and embedded search tools stay off.
  if (typeof (globalThis as DpBinGlobal).__dpBinOk === 'undefined') {
    try {
      const which = process.platform === 'win32' ? 'where' : 'which'
      execFileSync(which, ['bfs'], { encoding: 'utf8', timeout: 2000 })
      execFileSync(which, ['ugrep'], { encoding: 'utf8', timeout: 2000 })
      ;(globalThis as DpBinGlobal).__dpBinOk = true
    } catch {
      ;(globalThis as DpBinGlobal).__dpBinOk = false
    }
  }
  if (!(globalThis as DpBinGlobal).__dpBinOk) return false
  if (getSearchToolsOptIn()) return false
  return process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
}

/**
 * Path to the bun binary that contains the embedded search tools.
 * Only meaningful when hasEmbeddedSearchTools() is true.
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
