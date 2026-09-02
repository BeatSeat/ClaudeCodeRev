import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  buildGoalMetaPrompt,
  clearGoal,
  GOAL_CONDITION_MAX_CHARS,
  isGoalClearAlias,
  logGoalSetSad,
  setGoal,
} from './goal-core.js'
import { GoalOverlay } from './goal-overlay.js'

/** Official 2.1.139 vk5 / NZ4.call — local-jsx /goal */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = args.trim()
  if (trimmed === '') {
    const messages =
      'messages' in context && Array.isArray(context.messages)
        ? context.messages
        : []
    return (
      <GoalOverlay
        messages={messages}
        onDone={() => onDone(undefined, { display: 'skip' })}
      />
    )
  }
  if (isGoalClearAlias(trimmed)) {
    const previous = clearGoal(context)
    onDone(previous === null ? 'No goal set' : `Goal cleared: ${previous}`, {
      display: 'system',
    })
    return null
  }
  if (trimmed.length > GOAL_CONDITION_MAX_CHARS) {
    logGoalSetSad('too_long')
    onDone(
      `Goal condition is limited to ${GOAL_CONDITION_MAX_CHARS} characters (got ${trimmed.length})`,
      { display: 'system' },
    )
    return null
  }
  const error = setGoal(trimmed, context)
  if (error !== null) {
    onDone(error, { display: 'system' })
    return null
  }
  onDone(`Goal set: ${trimmed}`, {
    shouldQuery: true,
    metaMessages: [buildGoalMetaPrompt(trimmed)],
  })
  return null
}
