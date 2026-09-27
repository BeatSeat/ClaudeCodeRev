import type { Command } from '../../commands.js'

const toggleMemory = {
  type: 'local',
  name: 'toggle-memory',
  description: 'Toggle automemory off/on for this session',
  // Official 2.1.90 eNK: isEnabled is always false (command registered but gated).
  isEnabled: () => false,
  isHidden: false,
  supportsNonInteractive: false,
  userFacingName: () => 'toggle-memory',
  load: () => import('./toggle-memory.js'),
} satisfies Command

export default toggleMemory
