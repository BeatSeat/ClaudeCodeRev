import { closeSync } from 'fs'
import { constants as osConstants } from 'os'
import { dirname } from 'path'
import { isatty } from 'tty'
import { getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { isInBundledMode } from './bundledMode.js'
import { getCwd } from './cwd.js'
import { getProjectDir, getTranscriptPath } from './sessionStorage.js'

export function getRelaunchSpec(opts?: {
  pinToCurrentBinary?: boolean
}): { cmd: string; prefixArgs: string[] } {
  // Official 2.1.143 `jb({pinToCurrentBinary})`: force process.execPath when
  // the PATH-resolved launcher is gone (daemon ENOENT/EACCES fallback).
  if (opts?.pinToCurrentBinary || isInBundledMode()) {
    if (isInBundledMode() || !process.argv[1]) {
      return { cmd: process.execPath, prefixArgs: [] }
    }
    return { cmd: process.execPath, prefixArgs: [process.argv[1]] }
  }
  const script = process.argv[1]
  if (!script) {
    return { cmd: process.execPath, prefixArgs: [] }
  }
  return { cmd: process.execPath, prefixArgs: [script] }
}

/**
 * Official 2.1.116 ND6: spawn cwd for `/tui` / `/update` relaunch.
 * If the transcript lives in the current cwd's project dir, stay there
 * (same-project worktree). Otherwise fall back to projectRoot, which
 * EnterWorktreeTool does not rewrite mid-session.
 */
export function getRelaunchCwd(): string {
  const transcriptPath = getTranscriptPath()
  const cwd = getCwd()
  if (transcriptPath && dirname(transcriptPath) === getProjectDir(cwd)) {
    return cwd
  }
  return getProjectRoot()
}

/**
 * Official jF8 / severTtyInputForRelaunch: close TTY fds other than
 * stdout/stderr so the parent stops consuming stdin after spawn.
 * Fixes dropped keystrokes after `/tui` and provider-wizard relaunches.
 */
export function severTtyInputForRelaunch(): void {
  for (let fd = 0; fd < 32; fd++) {
    if (fd === 1 || fd === 2) continue
    try {
      if (isatty(fd)) closeSync(fd)
    } catch {
      // fd may already be closed or not a TTY handle
    }
  }
}

/** Official 2.1.98 T_Y / 2.1.110 y6Y: respawn this CLI with the same argv after setup. */
export async function execRelaunch(): Promise<void> {
  const { spawn } = await import('child_process')
  const { cmd, prefixArgs } = getRelaunchSpec()
  const child = spawn(cmd, [...prefixArgs, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  })
  severTtyInputForRelaunch()
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig)
      } catch {
        // Child may already have exited.
      }
    })
  }
  await new Promise<never>(() => {
    child.on('close', (code, signal) => {
      const fromSignal = signal
        ? 128 + ((osConstants.signals[signal] as number | undefined) ?? 0)
        : 0
      process.exit(code ?? fromSignal)
    })
    child.on('error', err => {
      process.stderr.write(`Failed to relaunch Claude Code: ${err.message}\n`)
      process.exit(1)
    })
  })
}

export type RelaunchSessionOptions = {
  freshIfNoTranscript?: boolean
  env?: NodeJS.ProcessEnv
  dropEnv?: string[]
  sessionId?: string
  transcriptPath?: string
  launcher?: { cmd: string; prefixArgs: string[] }
  preSpawn?: () => void
  args?: string[]
}

/**
 * Official 2.1.116 NA$: relaunch into the current session (`/tui`, `/update`).
 * Drops flicker-override env so the persisted `tui` setting wins.
 * Spawn cwd is ND6 so mid-session EnterWorktree does not break relaunch.
 */
export async function execRelaunchSession(
  options: RelaunchSessionOptions,
): Promise<void> {
  const { spawn } = await import('child_process')
  const { stat } = await import('fs/promises')
  const { cmd, prefixArgs } = options.launcher ?? getRelaunchSpec()
  const transcriptPath = options.transcriptPath ?? getTranscriptPath()
  let args: string[]
  if (options.args) {
    args = options.args
  } else if (options.freshIfNoTranscript) {
    const resume = transcriptPath
      ? await stat(transcriptPath).then(
          info => info.size > 0,
          () => false,
        )
      : false
    args = resume
      ? ['--resume', options.sessionId ?? getSessionId()]
      : []
  } else {
    args = ['--resume', options.sessionId ?? getSessionId()]
  }
  options.preSpawn?.()
  const env = { ...process.env }
  delete env.CLAUDE_CODE_TUI_JUST_SWITCHED
  Object.assign(env, options.env)
  for (const key of options.dropEnv ?? []) {
    delete env[key]
  }
  const child = spawn(cmd, [...prefixArgs, ...args], {
    stdio: 'inherit',
    env,
    cwd: getRelaunchCwd(),
  })
  child.ref()
  severTtyInputForRelaunch()
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.removeAllListeners(sig)
    process.on(sig, () => {})
  }
  await new Promise<never>(() => {
    child.on('close', (code, signal) => {
      const fromSignal = signal
        ? 128 + ((osConstants.signals[signal] as number | undefined) ?? 0)
        : 0
      process.exit(code ?? fromSignal)
    })
    child.on('error', err => {
      process.stderr.write(`Failed to relaunch Claude Code: ${err.message}\n`)
      process.exit(1)
    })
  })
}
