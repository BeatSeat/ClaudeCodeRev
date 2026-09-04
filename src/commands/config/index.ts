import type { Command } from '../../commands.js'

const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Change settings: hooks, permissions, environment variables',
  load: () => import('./config.js'),
} satisfies Command

export default config
