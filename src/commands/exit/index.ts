import type { Command } from '../../commands.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: 'Exit the REPL',
  immediate: true,
  load: () => import('./exit.js'),
} satisfies Command

/** Official 2.1.110 qaK — Remote Control counterpart (no Ink UI). */
export const exitNonInteractive = {
  type: 'local',
  name: 'exit',
  supportsNonInteractive: true,
  description: 'Exit the REPL',
  load: () => import('./exit-noninteractive.js'),
} satisfies Command

export default exit
