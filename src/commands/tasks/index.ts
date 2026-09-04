import type { Command } from '../../commands.js'

const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  aliases: ['bashes'],
  description: 'View and manage everything running in the background',
  load: () => import('./tasks.js'),
} satisfies Command

export default tasks
