import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { spawnForkFromDirective } from '../../tools/AgentTool/forkSubagent.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

export const call: LocalJSXCommandCall = async (
  onDone: LocalJSXCommandOnDone,
  context,
  args,
) => {
  const directive = args.trim()
  if (!directive) {
    onDone('Usage: /fork <directive>', { display: 'system' })
    return null
  }
  const result = await spawnForkFromDirective(
    directive,
    context,
    context.canUseTool,
  )
  if (!result) {
    onDone(
      isCoordinatorMode()
        ? 'Forking is not available in coordinator sessions. Use /branch instead.'
        : 'Cannot fork before the first conversation turn',
      { display: 'system' },
    )
    return null
  }
  onDone(`forked ${result.name} (${result.agentId.slice(-4)})`, {
    display: 'system',
  })
  return null
}
