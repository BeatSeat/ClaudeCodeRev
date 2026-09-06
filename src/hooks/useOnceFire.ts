/**
 * Official 2.1.179 `S4H` / `c74` / `Uo6` / `l74`.
 * Fire a side effect once per key per session (survives remounts).
 * Cleared on conversation reset via `clearOnceFireKeys` (`AGH` → `Uo6.clear`).
 */
import { useEffect } from 'react'

const firedKeys = new Set<string>()

/** Official 2.1.179 `c74`. Returns true on first add for `key`. */
export function claimOnceFireKey(key: string): boolean {
  if (firedKeys.has(key)) return false
  firedKeys.add(key)
  return true
}

/** Official 2.1.179 `Uo6.clear` (via `AGH` on conversation reset). */
export function clearOnceFireKeys(): void {
  firedKeys.clear()
}

type UseOnceFireOptions = {
  /** Official `enabled` default true. */
  enabled?: boolean
}

/**
 * Official 2.1.179 `S4H(key, fn, {enabled})`.
 * Context gate (`ME$`/`Fo6`) defaults true on this tree — no provider yet.
 */
export function useOnceFire(
  key: string,
  fn: () => void,
  { enabled = true }: UseOnceFireOptions = {},
): void {
  useEffect(() => {
    if (!enabled) return
    if (claimOnceFireKey(key)) fn()
  }, [enabled, key, fn])
}
