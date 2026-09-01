/**
 * Agents subcommand handler — prints the list of configured agents.
 * Dynamically imported only when `claude agents` runs.
 */

import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  type ResolvedAgent,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { logEvent } from '../../services/analytics/index.js'
import { listLiveSessions } from '../../utils/concurrentSessions.js'
import { getCwd } from '../../utils/cwd.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from 'path'

function formatAgent(agent: ResolvedAgent): string {
  const model = resolveAgentModelDisplay(agent)
  const parts = [agent.agentType]
  if (model) {
    parts.push(model)
  }
  if (agent.memory) {
    parts.push(`${agent.memory} memory`)
  }
  return parts.join(' · ')
}

/** Official 2.1.145 `l_A`. */
export async function printAgentsJson(cwdFilter?: string): Promise<void> {
  const filter = cwdFilter ? pathResolve(cwdFilter) : undefined
  const rows: Array<{
    pid: number
    cwd: string
    kind: 'background' | 'interactive'
    startedAt: number
    sessionId?: string
    name?: string
    status?: 'idle' | 'waiting' | 'busy'
  }> = []
  for (const session of await listLiveSessions()) {
    if (session.kind !== 'interactive' && session.kind !== 'bg') continue
    if (filter) {
      const rel = pathRelative(filter, session.cwd)
      if (rel.split(/[/\\]/, 1)[0] === '..' || isAbsolute(rel)) continue
    }
    rows.push({
      pid: session.pid,
      cwd: session.cwd,
      kind: session.kind === 'bg' ? 'background' : 'interactive',
      startedAt: session.startedAt,
      ...(session.sessionId && { sessionId: session.sessionId }),
      ...(session.name && { name: session.name }),
      ...(session.status && {
        status:
          session.status === 'idle'
            ? 'idle'
            : session.status === 'waiting'
              ? 'waiting'
              : 'busy',
      }),
    })
  }
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  process.stdout.write(`${jsonStringify(rows, null, 2)}\n`)
  logEvent('cli_agents_json', {})
}

export async function agentsHandler(): Promise<void> {
  const cwd = getCwd()
  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const activeAgents = getActiveAgentsFromList(allAgents)
  const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)

  const lines: string[] = []
  let totalActive = 0

  for (const { label, source } of AGENT_SOURCE_GROUPS) {
    const groupAgents = resolvedAgents
      .filter(a => a.source === source)
      .sort(compareAgentsByName)

    if (groupAgents.length === 0) continue

    lines.push(`${label}:`)
    for (const agent of groupAgents) {
      if (agent.overriddenBy) {
        const winnerSource = getOverrideSourceLabel(agent.overriddenBy)
        lines.push(`  (shadowed by ${winnerSource}) ${formatAgent(agent)}`)
      } else {
        lines.push(`  ${formatAgent(agent)}`)
        totalActive++
      }
    }
    lines.push('')
  }

  if (lines.length === 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('No agents found.')
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${totalActive} active agents\n`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(lines.join('\n').trimEnd())
  }
}
