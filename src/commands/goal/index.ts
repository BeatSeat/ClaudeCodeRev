import {
  getIsNonInteractiveSession,
  getIsRemoteMode,
} from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

/** Official 2.1.139 Nk5 */
const goal = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set a goal \u2014 keep working until the condition is met',
  argumentHint: '[<condition> | clear]',
  immediate: true,
  load: () => import('./goal.js'),
} satisfies Command

/** Official 2.1.139 Ek5 — goalNonInteractive */
export const goalNonInteractive = {
  type: 'local',
  name: 'goal',
  supportsNonInteractive: true,
  thinClientDispatch: 'post-text',
  description: 'Set a goal \u2014 keep working until the condition is met',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession() || getIsRemoteMode(),
  load: () => import('./goal-noninteractive.js'),
} as Command

export default goal
