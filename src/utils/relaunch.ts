import { closeSync } from 'fs'
import { constants as osConstants } from 'os'
import { isatty } from 'tty'
import { isInBundledMode } from './bundledMode.js'

function getRelaunchSpec(): { cmd: string; prefixArgs: string[] } {
  if (isInBundledMode()) {
    return { cmd: process.execPath, prefixArgs: [] }
  }
  const script = process.argv[1]
  if (!script) {
    return { cmd: process.execPath, prefixArgs: [] }
  }
  return { cmd: process.execPath, prefixArgs: [script] }
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
  sessionId: string
  transcriptPath?: string
}

/**
 * Official Nr8: relaunch into the current session (used by `/tui`).
 * Drops flicker-override env so the persisted `tui` setting wins.
 */
export async function execRelaunchSession(
  options: RelaunchSessionOptions,
): Promise<void> {
  const { spawn } = await import('child_process')
  const { stat } = await import('fs/promises')
  const { cmd, prefixArgs } = getRelaunchSpec()
  let resume = true
  if (options.freshIfNoTranscript) {
    const transcriptPath =
      options.transcriptPath ??
      (await import('./sessionStorage.js')).getTranscriptPath()
    resume = await stat(transcriptPath).then(
      info => info.size > 0,
      () => false,
    )
  }
  const env = { ...process.env }
  delete env.CLAUDE_CODE_TUI_JUST_SWITCHED
  Object.assign(env, options.env)
  for (const key of options.dropEnv ?? []) {
    delete env[key]
  }
  const args = resume
    ? [...prefixArgs, '--resume', options.sessionId]
    : [...prefixArgs]
  const child = spawn(cmd, args, { stdio: 'inherit', env })
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
