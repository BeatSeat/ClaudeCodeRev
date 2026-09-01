import { join } from 'path'
import chalk from 'chalk'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  execRelaunchSession,
  getRelaunchCwd,
  getRelaunchSpec,
} from '../../utils/relaunch.js'
import { getProjectDir, getTranscriptPath } from '../../utils/sessionStorage.js'
import { which } from '../../utils/which.js'

async function resolveLauncher(): Promise<{
  cmd: string
  prefixArgs: string[]
}> {
  const claude = await which('claude')
  if (claude) {
    return { cmd: claude, prefixArgs: [] }
  }
  return getRelaunchSpec()
}

export const call: LocalCommandCall = async (_args, context) => {
  const tasks = context.getAppState().tasks ?? {}
  if (
    Object.values(tasks).some(
      task => task.status === 'running' || task.status === 'pending',
    )
  ) {
    logEvent('tengu_update_refused', { active_tasks: true })
    return {
      type: 'text',
      value:
        'Cannot /update while background tasks are running — wait for them to finish, then try again.',
    }
  }

  const transcriptPath = getTranscriptPath()
  const expected = join(
    getProjectDir(getRelaunchCwd()),
    `${getSessionId()}.jsonl`,
  )
  if (transcriptPath && transcriptPath !== expected) {
    logEvent('tengu_update_refused', { transcript_path_drift: true })
    return {
      type: 'text',
      value:
        'Cannot /update — this session was resumed from a different project directory. Restart manually with --resume to continue on the latest version.',
    }
  }

  const teamName = context.getAppState().teamContext?.teamName
  const assistantTeam = teamName?.startsWith('assistant-') ? teamName : undefined

  await execRelaunchSession({
    launcher: await resolveLauncher(),
    freshIfNoTranscript: true,
    env: assistantTeam
      ? { CLAUDE_INTERNAL_ASSISTANT_TEAM_NAME: assistantTeam }
      : undefined,
    preSpawn: () =>
      process.stdout.write(
        chalk.dim(
          `\nSwitching from ${MACRO.VERSION} to latest… conversation will continue\n\n`,
        ),
      ),
  })

  return { type: 'text', value: 'Switching to the latest version…' }
}
