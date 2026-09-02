import type { LocalCommandCall } from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'
import {
  buildGoalMetaPrompt,
  clearGoal,
  formatLastCheck,
  getActiveGoal,
  GOAL_CONDITION_MAX_CHARS,
  isGoalClearAlias,
  logGoalSetSad,
  setGoal,
} from './goal-core.js'

/** Official 2.1.139 kk5 / yZ4.call — local non-interactive /goal */
export const call: LocalCommandCall = async (args, context) => {
  const trimmed = args.trim()
  if (trimmed === '') {
    const goal = getActiveGoal(context.getAppState())
    if (!goal) {
      return { type: 'text', value: 'No goal set. Usage: `/goal <condition>`' }
    }
    const turns =
      goal.iterations === 0
        ? 'not yet evaluated'
        : `${goal.iterations} ${plural(goal.iterations, 'turn')}`
    const last = goal.lastReason ? `\n${formatLastCheck(goal.lastReason)}` : ''
    return {
      type: 'text',
      value: `Goal active: ${goal.condition} (${turns})${last}`,
    }
  }
  if (isGoalClearAlias(trimmed)) {
    const previous = clearGoal(context)
    return {
      type: 'text',
      value: previous === null ? 'No goal set' : `Goal cleared: ${previous}`,
    }
  }
  if (trimmed.length > GOAL_CONDITION_MAX_CHARS) {
    logGoalSetSad('too_long')
    return {
      type: 'text',
      value: `Goal condition is limited to ${GOAL_CONDITION_MAX_CHARS} characters (got ${trimmed.length})`,
    }
  }
  const error = setGoal(trimmed, context)
  if (error !== null) {
    return { type: 'text', value: error }
  }
  // Official 2.1.139 kk5: {type:"query", value, prompt:bj8(q)}
  return {
    type: 'query',
    value: `Goal set: ${trimmed}`,
    prompt: buildGoalMetaPrompt(trimmed),
  }
}
