import type { Command } from '../commands.js'

/**
 * Official 2.1.178 `it4` + `GCf` DCE. The `/commit` builtin is no longer
 * registered (`Create a git commit` 1→0). Keep a disabled Command export so
 * `src/commands.ts` still typechecks.
 */
const command = {
  type: 'prompt',
  name: 'commit',
  description: 'commit',
  isEnabled: () => false,
  isHidden: true,
  allowedTools: [],
  contentLength: 0,
  progressMessage: 'commit',
  source: 'builtin',
  async getPromptForCommand() {
    return [{ type: 'text' as const, text: '' }]
  },
} satisfies Command

export default command
