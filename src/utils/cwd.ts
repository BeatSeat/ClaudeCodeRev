import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, setCwdState } from '../bootstrap/state.js'

/**
 * Official 2.1.97 stores a mutable `{cwd}` object in ALS so worktree / `cwd:`
 * subagents can `cd` without leaking into the parent Bash. 2.1.96 stored a
 * bare string, which is immutable — `setCwd` had to fall back to the process
 * global and the parent's next Bash call inherited the child's directory.
 */
type CwdStore = { cwd: string }

const cwdOverride = new AsyncLocalStorage<CwdStore>()

function normalizeCwd(path: string): string {
  return path.normalize('NFC')
}

/**
 * Run `fn` with an isolated cwd. Nested `setCwd` updates this store only.
 */
export function runWithCwd<T>(path: string, fn: () => T): T {
  return cwdOverride.run({ cwd: normalizeCwd(path) }, fn)
}

/**
 * Alias used by AgentTool / resumeAgent. Same isolation as {@link runWithCwd}.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return runWithCwd(cwd, fn)
}

export function getCwdOverride(): string | undefined {
  return cwdOverride.getStore()?.cwd
}

export function hasCwdOverride(): boolean {
  return cwdOverride.getStore() !== undefined
}

/**
 * Current cwd: ALS store when present, otherwise the process-global state.
 */
export function getCwd(): string {
  return cwdOverride.getStore()?.cwd ?? getCwdState()
}

/**
 * Alias for {@link getCwd}.
 */
export function pwd(): string {
  return getCwd()
}

/**
 * Update cwd. If an ALS store is active, mutate it in place so the parent
 * process global is unchanged. Otherwise write the global (bootstrap / REPL).
 */
export function setCwd(path: string): void {
  const normalized = normalizeCwd(path)
  const store = cwdOverride.getStore()
  if (store) {
    store.cwd = normalized
    return
  }
  setCwdState(normalized)
}
