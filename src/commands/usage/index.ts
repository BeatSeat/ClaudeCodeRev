import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

/** Official 2.1.118 VL6 — interactive /usage (aliases /cost /stats). */
const usage = {
  type: 'local-jsx',
  name: 'usage',
  aliases: ['cost', 'stats'],
  description: 'Show session cost, plan usage, and activity stats',
  load: () => import('./usage.js'),
} satisfies Command

/** Official 2.1.118 NL6 — non-interactive /usage text (same aliases). */
export const usageNonInteractive = {
  type: 'local',
  name: 'usage',
  aliases: ['cost', 'stats'],
  supportsNonInteractive: true,
  description: 'Show the total cost and duration of the current session',
  isEnabled: () => getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('../cost/cost.js'),
} satisfies Command

export default usage
