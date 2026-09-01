import type { Command } from '../../commands.js'
import { isWorkflowsEnabled } from '../../utils/workflows/enabled.js'

/**
 * Official 2.1.153 `/workflows` (`nOz`). `load` returns `js4`
 * (`WorkflowsDialog`) via `Ds4.call`.
 */
const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  aliases: [],
  description: 'Browse dynamic workflow history (running and completed)',
  isEnabled: () => isWorkflowsEnabled(),
  load: () => import('./WorkflowsDialog.js'),
} satisfies Command

export default workflows
