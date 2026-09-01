import { clearCommandsCache, getCommands } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { notifySkillsChanged } from '../../utils/skills/skillChangeDetector.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async () => {
  const cwd = getCwd()
  const before = await getCommands(cwd)
  const beforeNames = new Set(before.map(cmd => cmd.name))
  clearCommandsCache()
  const after = await getCommands(cwd)
  const afterNames = new Set(after.map(cmd => cmd.name))
  notifySkillsChanged()
  const added = after.filter(cmd => !beforeNames.has(cmd.name)).length
  const removed = before.filter(cmd => !afterNames.has(cmd.name)).length
  const parts: string[] = []
  if (added > 0) parts.push(`${added} added`)
  if (removed > 0) parts.push(`${removed} removed`)
  const change = parts.length > 0 ? parts.join(', ') : 'no changes'
  return {
    type: 'text',
    value: `Reloaded skills: ${after.length} ${plural(after.length, 'skill')} available (${change})`,
  }
}
