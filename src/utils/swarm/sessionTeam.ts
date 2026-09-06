import { rename } from 'fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import { AGENT_COLORS } from '../../tools/AgentTool/agentColorManager.js'
import { formatAgentId } from '../agentId.js'
import { getCwd } from '../cwd.js'
import { ensureTasksDir, getTasksDir, notifyTasksUpdated } from '../tasks.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  registerTeamForSessionCleanup,
  writeTeamFileAsync,
  type TeamFile,
} from './teamHelpers.js'

/** Official 2.1.178 `IRz`. */
const SESSION_TEAM_PREFIX = 'session'

/** Official 2.1.178 `CRz` one-shot. */
let inheritedAssistantTeamName: string | null | undefined

/**
 * Official 2.1.178 `b$1`.
 */
export function sessionTeamName(sessionId: string): string {
  return `${SESSION_TEAM_PREFIX}-${sessionId.slice(0, 8)}`
}

/** Official 2.1.178 `CRz`. */
export function consumeInheritedAssistantTeamName(): string | null {
  if (inheritedAssistantTeamName === undefined) {
    inheritedAssistantTeamName =
      process.env.CLAUDE_INTERNAL_ASSISTANT_TEAM_NAME || null
    delete process.env.CLAUDE_INTERNAL_ASSISTANT_TEAM_NAME
  }
  return inheritedAssistantTeamName ?? null
}

/** Official 2.1.178 `bRz`. */
export function resetInheritedAssistantTeamName(): void {
  inheritedAssistantTeamName = undefined
}

export type SessionTeamInit = {
  teamContext: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    teammates: {
      [id: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        spawnedAt: number
      }
    }
  }
  teammateColors: {
    assignments: Map<string, string>
    index: number
  }
}

/**
 * Official 2.1.178 `xRz`. Implicit session team — no TeamCreate.
 * Call site is `main.tsx` / CLI (out of lock).
 */
export async function initializeSessionTeam(opts?: {
  existingTeamName?: string
}): Promise<SessionTeamInit> {
  const inherited = opts?.existingTeamName || consumeInheritedAssistantTeamName()
  const teamName = inherited ?? sessionTeamName(getSessionId())
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const teamFilePath = getTeamFilePath(teamName)
  const existing = inherited ? await readTeamFileAsync(teamName) : null
  if (!existing) {
    const teamFile: TeamFile = {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: getSessionId(),
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          joinedAt: Date.now(),
          tmuxPaneId: 'leader',
          cwd: getCwd(),
          subscriptions: [],
          backendType: 'in-process',
        },
      ],
    }
    await writeTeamFileAsync(teamName, teamFile)
  }
  registerTeamForSessionCleanup(teamName)
  const sessionId = getSessionId()
  if (teamName !== sessionId) {
    await rename(getTasksDir(sessionId), getTasksDir(teamName)).catch(() => {})
  }
  await ensureTasksDir(teamName)
  notifyTasksUpdated()
  const color = AGENT_COLORS[0]!
  return {
    teamContext: {
      teamName,
      teamFilePath,
      leadAgentId,
      teammates: {
        [leadAgentId]: {
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          color,
          tmuxSessionName: 'in-process',
          tmuxPaneId: 'leader',
          cwd: getCwd(),
          spawnedAt: Date.now(),
        },
      },
    },
    teammateColors: {
      assignments: new Map([[leadAgentId, color]]),
      index: 1,
    },
  }
}
