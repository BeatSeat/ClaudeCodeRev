/**
 * Official 2.1.187 `/btw` side-question history store (bundle `t9t` / `mul` / `hul` / `aHo`).
 * Module-level session store — survives successive /btw invocations in one process.
 */

export type BtwHistoryEntry = {
  question: string
  response: string
}

/** Official 2.1.187 `Ujp` — max retained Q&A pairs. */
const BTW_HISTORY_MAX = 20

type BtwHistoryState = {
  history: BtwHistoryEntry[]
}

function createBtwHistoryState(): BtwHistoryState {
  return { history: [] }
}

const btwHistoryState: BtwHistoryState = createBtwHistoryState()

/** Official 2.1.187 `mul`. */
export function getBtwHistory(): BtwHistoryEntry[] {
  return btwHistoryState.history
}

/** Official 2.1.187 `hul`. */
export function setBtwHistory(history: BtwHistoryEntry[]): void {
  btwHistoryState.history = history
}

/** Official 2.1.187 `aHo`. */
export function appendBtwHistory(question: string, response: string): void {
  btwHistoryState.history = [
    ...btwHistoryState.history,
    { question, response },
  ].slice(-BTW_HISTORY_MAX)
}
