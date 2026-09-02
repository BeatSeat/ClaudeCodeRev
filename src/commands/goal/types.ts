import type { AppState } from '../../state/AppState.js'

/** Official 2.1.139 — session-scoped /goal progress (AppState.activeGoal). */
export type ActiveGoal = {
  condition: string
  iterations: number
  setAt: number
  tokensAtStart: number
  lastReason?: string
}

export type AppStateWithGoal = AppState & { activeGoal?: ActiveGoal }
