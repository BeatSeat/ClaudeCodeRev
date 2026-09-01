/**
 * Official 2.1.94 rA7/oA7: a tiny emit/subscribe bus so REPL can
 * useSyncExternalStore the current session title after /rename, --name,
 * or a UserPromptSubmit hook sessionTitle.
 */

type Listener = () => void

const listeners = new Set<Listener>()

export function emitSessionTitleChanged(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeSessionTitleChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
