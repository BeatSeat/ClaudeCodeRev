import { constants as osConstants } from 'os'
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

/** Official 2.1.98 T_Y: respawn this CLI with the same argv after setup. */
export async function execRelaunch(): Promise<void> {
  const { spawn } = await import('child_process')
  const { cmd, prefixArgs } = getRelaunchSpec()
  const child = spawn(cmd, [...prefixArgs, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  })
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
