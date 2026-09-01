import { logEvent } from '../../services/analytics/index.js'

/** Official 2.1.132 `tengu_goal_achieved` (evaluator). Full /goal UI is 139. */
export function logGoalAchieved(promptLength: number): void {
  logEvent('tengu_goal_achieved', { promptLength })
}
