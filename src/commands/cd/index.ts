import type { Command } from '../../commands.js'

const cd = {
  type: 'local-jsx',
  name: 'cd',
  description: 'Move this session to a new working directory',
  argumentHint: '<path>',
  load: () => import('./cd.js'),
} satisfies Command

export default cd
