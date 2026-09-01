import type { Command } from '../../commands.js'

const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Manage Claude Code plugins',
  immediate: true,
  load: () => import('./plugin.js'),
  // Official 2.1.157 XAz: lazy DAz getPluginArgumentCompletions
  getArgumentCompletions: (completed, partial) =>
    import('./getPluginArgumentCompletions.js').then(m =>
      m.getPluginArgumentCompletions(completed, partial),
    ),
} satisfies Command

export default plugin
