import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'env',
  description: 'Set environment variables for this session',
  argumentHint: '[NAME=value | unset NAME]',
  supportsNonInteractive: false,
  load: () => import('./env.js'),
} satisfies Command
