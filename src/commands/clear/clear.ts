import type { LocalCommandCall } from '../../types/command.js'
import { clearConversation } from './conversation.js'

export const call: LocalCommandCall = async (_, context) => {
  await clearConversation(context)
  // Official 2.1.129: reset the Haiku tab title AFTER clear so we do not
  // fight Core on conversation.ts (JS calls resetTerminalTitle inside
  // clearConversation; same effect from the /clear host).
  context.resetTerminalTitle?.()
  return { type: 'text', value: '' }
}
