import type { Command } from '../../commands.js'

const pauseMemory = {
  type: 'local',
  name: 'pause-memory',
  aliases: ['memory-pause', 'toggle-memory'],
  description: 'Pause automemory for this session',
  // Official 2.1.187: isEnabled is always false (command registered but gated).
  isEnabled: () => false,
  isHidden: false,
  supportsNonInteractive: false,
  userFacingName: () => 'pause-memory',
  load: () => import('./pause-memory.js'),
} satisfies Command

export default pauseMemory
