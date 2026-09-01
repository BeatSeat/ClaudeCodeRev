import { useSyncExternalStore } from 'react'
import type { SpinnerMode } from './types.js'

/**
 * Official 2.1.152 `Sn7` / `$Z$`: last time the spinner entered "thinking".
 * Null when the stream is not currently thinking — the live "Thinking for Ns"
 * ticker freezes at thoughtForMs.
 */
let thinkingStartedAt: number | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getThinkingStartedAt(): number | null {
  return thinkingStartedAt
}

export function subscribeThinkingStartedAt(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function syncThinkingStartedAt(mode: SpinnerMode): void {
  const next = mode === 'thinking' ? (thinkingStartedAt ?? Date.now()) : null
  if (next === thinkingStartedAt) return
  thinkingStartedAt = next
  emit()
}

export function useThinkingStartedAt(): number | null {
  return useSyncExternalStore(subscribeThinkingStartedAt, getThinkingStartedAt)
}
