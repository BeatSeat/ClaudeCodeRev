/**
 * Official 2.1.153 `I7`. Same subscribe/emit/clear shape as createSignal,
 * but emit rethrows listener errors (single throw or AggregateError).
 */
export type DaemonSignal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createDaemonSignal<
  Args extends unknown[] = [],
>(): DaemonSignal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args) {
      let errors: unknown[] | undefined
      for (const listener of listeners) {
        try {
          listener(...args)
        } catch (err) {
          ;(errors ??= []).push(err)
        }
      }
      if (errors) {
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, 'Signal listener(s) threw')
      }
    },
    clear() {
      listeners.clear()
    },
  }
}
