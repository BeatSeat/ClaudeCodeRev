import type { Command } from '../../commands.js'

const focus = {
  type: 'local-jsx',
  name: 'focus',
  description:
    'Toggle focus view (show only your prompt, a tool summary, and the final response)',
  immediate: true,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
