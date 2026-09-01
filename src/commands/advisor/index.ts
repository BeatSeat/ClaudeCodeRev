import type { Command } from '../../commands.js'
import {
  ADVISOR_MODELS,
  canUserConfigureAdvisor,
} from '../../utils/advisor.js'

const advisor = {
  type: 'local-jsx',
  name: 'advisor',
  description:
    'Configure the Advisor Tool to consult a stronger model for guidance at key moments during a task',
  argumentHint: `[${[...ADVISOR_MODELS, 'off'].join('|')}]`,
  isEnabled: () => canUserConfigureAdvisor(),
  get isHidden() {
    return !canUserConfigureAdvisor()
  },
  load: () => import('./advisor.js'),
} satisfies Command

export default advisor
