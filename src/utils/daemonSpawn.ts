import { spawn } from 'child_process'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { getErrnoCode } from './errors.js'
import { getRelaunchSpec } from './relaunch.js'

/**
 * Official 2.1.143 `aN4` + `UP8`: detached spawn, then retry with
 * `pinToCurrentBinary` when the PATH binary is gone (ENOENT/EACCES).
 */
export async function spawnDetachedDaemon(
  extraArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Error | null> {
  const first = getRelaunchSpec()
  const err = await spawnDetached(
    [first.cmd, ...first.prefixArgs, ...extraArgs],
    env,
  )
  const code = getErrnoCode(err)
  if (code === 'ENOENT' || code === 'EACCES') {
    const pinned = getRelaunchSpec({ pinToCurrentBinary: true })
    if (pinned.cmd !== first.cmd) {
      logEvent('tengu_bg_daemon_spawn_execpath_fallback', {
        errno_enoent: code === 'ENOENT',
        errno_eacces: code === 'EACCES',
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      return spawnDetached(
        [pinned.cmd, ...pinned.prefixArgs, ...extraArgs],
        env,
      )
    }
  }
  return err
}

async function spawnDetached(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<Error | null> {
  let spawnError: Error | null = null
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.once('error', err => {
      spawnError = err
    })
    child.unref()
  } catch (err) {
    spawnError = err instanceof Error ? err : new Error(String(err))
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  return spawnError
}
