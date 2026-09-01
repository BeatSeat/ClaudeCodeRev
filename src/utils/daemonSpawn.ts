import { spawn } from 'child_process'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { rcompare, valid } from 'semver'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { getRelaunchSpec } from './relaunch.js'

/**
 * Official 2.1.154 `aW8`: last-resort daemon binary lookup. Reads
 * `~/.claude/versions`, keeps only valid semver entries (skipping
 * in-flight `.tmp.<n>.<n>` temp files), sorts newest-first, and returns the
 * first one that exists and is non-empty, or null.
 */
async function findLatestVersionedBinary(): Promise<string | null> {
  const versionsDir = join(getClaudeConfigHomeDir(), 'versions')
  let entries: string[]
  try {
    entries = await readdir(versionsDir)
  } catch {
    return null
  }
  const candidates = entries
    .filter(name => !/\.tmp\.\d+\.\d+$/.test(name) && valid(name) !== null)
    .sort(rcompare)
  for (const name of candidates) {
    const candidatePath = join(versionsDir, name)
    try {
      const info = await stat(candidatePath)
      if (info.isFile() && info.size > 0) {
        return candidatePath
      }
    } catch {
      // candidate missing or unreadable — keep scanning
    }
  }
  return null
}

/**
 * Official 2.1.143 `aN4` + `UP8`, extended by 2.1.154 `aW8`: detached spawn,
 * then retry with `pinToCurrentBinary` when the PATH binary is gone
 * (ENOENT/EACCES), then fall back to the newest binary under
 * `~/.claude/versions` when even the pinned binary is ENOENT.
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
      const pinnedErr = await spawnDetached(
        [pinned.cmd, ...pinned.prefixArgs, ...extraArgs],
        env,
      )
      if (getErrnoCode(pinnedErr) !== 'ENOENT') {
        return pinnedErr
      }
      // 2.1.154: PATH and pinned binary are both gone — try the versions dir.
      const versioned = await findLatestVersionedBinary()
      logEvent('tengu_bg_daemon_spawn_versions_fallback', {
        found: versioned !== null,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      if (versioned !== null && versioned !== pinned.cmd) {
        return spawnDetached([versioned, ...extraArgs], env)
      }
      return pinnedErr
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
