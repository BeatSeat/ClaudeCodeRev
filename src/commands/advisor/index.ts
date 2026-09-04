import type { Command } from '../../commands.js'
import {
  ADVISOR_MODELS,
  canUserConfigureAdvisor,
} from '../../utils/advisor.js'

const advisor = {
  type: 'local-jsx',
  name: 'advisor',
  description:
    'Let Claude consult a stronger model at key moments',
  argumentHint: `[${[...ADVISOR_MODELS, 'off'].join('|')}]`,
  isEnabled: () => canUserConfigureAdvisor(),
  get isHidden() {
    return !canUserConfigureAdvisor()
  },
  load: () => import('./advisor.js'),
} satisfies Command

export default advisor
