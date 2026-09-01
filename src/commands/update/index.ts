import type { Command } from '../../commands.js'

const update = {
  type: 'local',
  name: 'update',
  description: 'Switch to the latest version (conversation continues)',
  supportsNonInteractive: false,
  // Official 2.1.116: present but disabled/hidden. Do not invent enablement.
  isEnabled: () => false,
  isHidden: true,
  load: () => import('./update.js'),
} satisfies Command

export default update
