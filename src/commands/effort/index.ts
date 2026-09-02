import type { Command } from '../../commands.js'
import { isUltracodeEffortAvailable } from '../../utils/effort.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  get argumentHint() {
    return isUltracodeEffortAvailable(getMainLoopModel())
      ? '[low|medium|high|xhigh|max|ultracode|auto]'
      : '[low|medium|high|xhigh|max|auto]'
  },
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
