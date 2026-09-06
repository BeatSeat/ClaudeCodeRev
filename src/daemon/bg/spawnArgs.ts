import { mkdir, writeFile } from 'fs/promises'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
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

/** Official 2.1.174 `cS6` + `RD7` + `LG$` + `gS6` + `dS6` extras — `FXq`. */
export const STRIP_PROVIDER_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'CLOUD_ML_REGION',
  'ANTHROPIC_BASE_URL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
]

/** Official 2.1.174 `PG$`. */
const STRIP_API_KEY_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_BEDROCK_MANTLE_API_KEY',
]

/** Official 2.1.174 `WG$`. */
const VERTEX_REGION_ENV_PREFIXES = ['VERTEX_REGION_CLAUDE_']

/** Official 2.1.174 `QXq`. */
function isHostManagedProviderEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    !!env.ANTHROPIC_UNIX_SOCKET ||
    isEnvTruthy(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) ||
    !!env.CLAUDE_CODE_HOST_AUTH_ENV_VAR
  )
}

function stripHostManagedApiKeys(env: NodeJS.ProcessEnv): void {
  const hostVar = env.CLAUDE_CODE_HOST_AUTH_ENV_VAR
  if (hostVar) delete env[hostVar]
  for (const z of STRIP_API_KEY_ENV) delete env[z]
}

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
  const snapshot = { ...process.env }
  const env: NodeJS.ProcessEnv = {
    ...snapshot,
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
  for (const z of STRIP_PROVIDER_ENV) {
    if (!dispatch.env?.[z]) delete env[z]
  }
  for (const z of Object.keys(env)) {
    if (
      VERTEX_REGION_ENV_PREFIXES.some(prefix => z.startsWith(prefix)) &&
      !dispatch.env?.[z]
    ) {
      delete env[z]
    }
  }
  if (isHostManagedProviderEnv(snapshot)) {
    stripHostManagedApiKeys(env)
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

/** Official 2.1.174 `BVA` — spare-worker env isolated from the daemon shell. */
export function spareWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const z of STRIP_ENV) delete env[z]
  if (isHostManagedProviderEnv(env)) {
    stripHostManagedApiKeys(env)
  }
  for (const z of STRIP_PROVIDER_ENV) delete env[z]
  for (const z of Object.keys(env)) {
    if (VERTEX_REGION_ENV_PREFIXES.some(prefix => z.startsWith(prefix))) {
      delete env[z]
    }
  }
  if (getPlatform() === 'macos') delete env.CLAUDE_CODE_OAUTH_TOKEN
  return Object.assign(env, {
    CLAUDE_CODE_SESSION_KIND: 'bg',
    CLAUDE_BG_BACKEND: 'daemon',
    CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
    FORCE_COLOR: '3',
    COLORTERM: 'truecolor',
    BROWSER: 'true',
  })
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
