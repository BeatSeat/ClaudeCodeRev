import type { Command } from '../../commands.js'

const stopHook = {
  type: 'local-jsx',
  name: 'stop-hook',
  description: 'Set a session-only Stop hook with a quick prompt',
  immediate: true,
  // Official 2.1.92/98 ships the command but keeps it disabled.
  isEnabled: () => false,
  load: () => import('./stop-hook.js'),
} satisfies Command

export default stopHook
