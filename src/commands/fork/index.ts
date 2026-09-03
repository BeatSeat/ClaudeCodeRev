import type { Command } from '../../commands.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'

const fork = {
  type: 'local-jsx',
  name: 'fork',
  description: 'Spawn a background agent that inherits the full conversation',
  argumentHint: '<directive>',
  isEnabled: () => !isCoordinatorMode(),
  load: () => import('./fork.js'),
} satisfies Command

export default fork
