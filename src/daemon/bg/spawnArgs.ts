import { mkdir, writeFile } from 'fs/promises'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { authDir, authSnapshotPath } from './paths.js'
import type { AuthSnapshot, Dispatch } from './types.js'

/** Official `oqq` — env keys stripped unless the dispatch re-supplies them. */
export const STRIP_ENV = [
  'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
  'GITHUB_ACTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_COORDINATOR_MODE',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  '__CFBundleIdentifier',
  'KITTY_WINDOW_ID',
  'WT_SESSION',
  'KONSOLE_VERSION',
  'VTE_VERSION',
  'ZED_TERM',
  'ZELLIJ',
  'TMUX',
  'TMUX_PANE',
  'STY',
  'LC_TERMINAL',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
  'COLORFGBG',
  'CURSOR_TRACE_ID',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_IPC_HANDLE',
  'TERMINAL_EMULATOR',
  'ITERM_SESSION_ID',
  'GNOME_TERMINAL_SERVICE',
  'XTERM_VERSION',
  'ALACRITTY_LOG',
  'TILIX_ID',
  'TERMINATOR_UUID',
  'ConEmuANSI',
  'ConEmuPID',
  'ConEmuTask',
  'MSYSTEM',
  'CLAUDE_CODE_SSE_PORT',
  'FORCE_CODE_TERMINAL',
]

/** Official `c89`. */
export function workerArgv(
  dispatch: Dispatch,
  attempt: number,
  hasResume: boolean,
  sessionId: string,
  respawnFlags: string[],
): string[] {
  if (dispatch.launch.mode === 'exec') return dispatch.launch.args
  if (attempt > 1 && hasResume) return ['--resume', sessionId, ...respawnFlags]
  if (dispatch.launch.mode === 'resume') {
    return [
      ...(dispatch.launch.fork
        ? ['--session-id', dispatch.sessionId, '--fork-session']
        : []),
      '--resume',
      dispatch.launch.sessionId,
      ...dispatch.launch.flagArgs,
    ]
  }
  return dispatch.launch.args
}

/** Official `l89`. */
export function workerEnv(
  dispatch: Dispatch,
  jobDirPath: string,
  authSnapshot: string | undefined,
  rvSock: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(getPlatform() === 'windows' && {
      CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
    }),
    ...dispatch.env,
    CLAUDE_CODE_SESSION_KIND: 'bg',
    CLAUDE_BG_BACKEND: 'daemon',
    CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
    CLAUDE_BG_SOURCE: dispatch.source,
    CLAUDE_JOB_DIR: jobDirPath,
    CLAUDE_CODE_SESSION_NAME:
      dispatch.seed?.name || dispatch.seed?.intent || dispatch.short,
    CLAUDE_BG_RENDEZVOUS_SOCK: rvSock,
    FORCE_COLOR: '3',
    COLORTERM: 'truecolor',
    BROWSER: 'true',
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  }
  if (dispatch.isolation === 'worktree') env.CLAUDE_BG_ISOLATION = 'worktree'
  for (const z of STRIP_ENV) {
    if (!dispatch.env?.[z]) delete env[z]
  }
  if (authSnapshot) delete env.CLAUDE_CODE_OAUTH_TOKEN
  if (dispatch.launch.mode === 'exec') {
    for (const z of Object.keys(env)) {
      if (
        (z.startsWith('CLAUDE_') &&
          z !== 'CLAUDE_JOB_DIR' &&
          z !== 'CLAUDE_CONFIG_DIR') ||
        z.startsWith('OTEL_')
      ) {
        delete env[z]
      }
    }
    delete env.BROWSER
    env.CLAUDE_PTY_HOST_EXEC = '1'
  }
  return env
}

/** Official `rqq`. Auth snapshot is macOS-only. */
export async function writeAuthSnapshot(
  short: string,
  snapshot: AuthSnapshot | undefined,
): Promise<string | undefined> {
  if (!snapshot || getPlatform() !== 'macos') return
  const q = authSnapshotPath(short)
  try {
    await mkdir(authDir(), { recursive: true, mode: 0o700 })
    await writeFile(q, jsonStringify(snapshot), { mode: 0o600 })
    return q
  } catch (err) {
    logForDebugging(`writeAuthSnapshot failed: ${errorMessage(err)}`, {
      level: 'warn',
    })
    return
  }
}
