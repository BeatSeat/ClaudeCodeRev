import { createHash, randomBytes } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'

/** Official `d8` — already `getClaudeConfigHomeDir`. */

/** Official `sG`. */
export function jobsDir(): string {
  return join(getClaudeConfigHomeDir(), 'jobs')
}

/** Official `b9`. */
export function jobDir(short: string): string {
  return join(jobsDir(), short)
}

/** Official `zIH`. */
export function daemonDir(): string {
  return join(getClaudeConfigHomeDir(), 'daemon')
}

/** Official `PC`. */
export function daemonJsonPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.json')
}

/** Official `wPH`. */
export function daemonLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.log')
}

/** Official `jPH` / `TE4`. */
export function daemonLockPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.lock')
}

/** Official `AIH`. */
export function dispatchDir(): string {
  return join(daemonDir(), 'dispatch')
}

/** Official `Jo6`. */
export function dispatchRejectedDir(): string {
  return join(daemonDir(), 'dispatch', 'rejected')
}

/** Official `IzH`. */
export function rosterPath(): string {
  return join(daemonDir(), 'roster.json')
}

/** Official `Xo6`. */
export function rvDir(): string {
  return join(jobsDir(), 'rv')
}

/** Official `Lo6`. */
export function authDir(): string {
  return join(jobsDir(), 'auth')
}

/** Official `tk$`. */
export function authSnapshotPath(short: string): string {
  return join(authDir(), `${short}.json`)
}

/** Official `m$$`. */
export function ptyDir(): string {
  return join(jobsDir(), 'pty')
}

/** Official `Wl`. */
export function spareDir(): string {
  return join(jobsDir(), 'spare')
}

/** Official `IE4`. */
export function sparePtySock(id: string): string {
  return join(spareDir(), `${id}.pty.sock`)
}

/** Official `CE4`. */
export function spareClaimSock(id: string): string {
  return join(spareDir(), `${id}.claim.sock`)
}

/** Official `YIH`. */
export function ptyPidsDir(): string {
  return join(daemonDir(), 'pty-pids')
}

/** Official `CzH`. */
export function windowsPtyPidPath(short: string): string {
  return join(ptyPidsDir(), `${short}.pid`)
}

/** Official `cX6` pins file used by `Tw$`. */
export function pinsPath(): string {
  return join(jobsDir(), 'pins.json')
}

/** Official `Yo_`. */
export const configFingerprint = memoize(
  (): string =>
    createHash('sha256')
      .update(resolve(getClaudeConfigHomeDir()))
      .digest('hex')
      .slice(0, 8),
  () => resolve(getClaudeConfigHomeDir()),
)

/**
 * Official `Hs`. Runtime jobs/control dir under /tmp (or Termux PREFIX/tmp),
 * keyed on config home so a CLAUDE_CONFIG_DIR change rememoizes.
 */
export const runtimeDaemonDir = memoize((): string => {
  const uid = process.getuid?.() ?? 0
  const tmp =
    process.env.TERMUX_VERSION && process.env.PREFIX
      ? join(process.env.PREFIX, 'tmp')
      : '/tmp'
  return join(tmp, `cc-daemon-${uid}`, configFingerprint())
}, () => getClaudeConfigHomeDir())

/** Official `Oo_`. */
export const pipeKey = memoize((): string => {
  const keyPath = join(daemonDir(), 'pipe.key')
  try {
    return readFileSync(keyPath, 'utf8').trim()
  } catch (err) {
    if (!isENOENT(err)) throw err
  }
  const generated = randomBytes(8).toString('hex')
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(keyPath, generated, { flag: 'wx', mode: 0o600 })
    return generated
  } catch {
    return readFileSync(keyPath, 'utf8').trim()
  }
})

/** Official `Do6`. */
export function windowsPipe(name: string): string {
  return `\\\\.\\pipe\\cc-daemon-${pipeKey()}-${name}`
}

/** Official `u$$`. */
export function rendezvousSock(short: string): string {
  if (getPlatform() === 'windows') return windowsPipe(`rv-${short}`)
  return join(rvDir(), `${short}.sock`)
}

/** Official `uU`. */
export function ptySock(short: string): string {
  if (getPlatform() === 'windows') return windowsPipe(`pty-${short}`)
  return join(ptyDir(), `${short}.sock`)
}

/** Official `hS`. */
export function sockErrPath(sock: string): string {
  if (getPlatform() === 'windows') {
    return join(ptyPidsDir(), `${sock.split('\\').pop()}.err`)
  }
  return `${sock}.err`
}

/** Official `Zl`. */
export function controlSock(): string {
  if (getPlatform() === 'windows') return windowsPipe('control')
  return join(runtimeDaemonDir(), 'control.sock')
}

/** Official `lV8`. */
export async function ensureRuntimeDaemonDir(): Promise<void> {
  if (getPlatform() === 'windows') return
  const dir = runtimeDaemonDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const now = new Date()
  const { utimes, lstat, chmod } = await import('fs/promises')
  await utimes(dir, now, now).catch(() => {})
  const uid = process.getuid?.()
  const { dirname } = await import('path')
  for (const p of [dirname(dir), dir]) {
    const st = await lstat(p)
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(`refusing to bind: ${p} is owned by uid ${st.uid}`)
    }
    if ((st.mode & 511) !== 448) await chmod(p, 0o700)
  }
}

/** Official 2.1.176 `M69` (175 `ee4` was a Windows no-op). */
export async function ensureDaemonDir(): Promise<void> {
  const dir = daemonDir()
  const { mkdir: mkdirP, lstat, chmod } = await import('fs/promises')
  if (getPlatform() === 'windows') {
    await mkdirP(dir, { recursive: true })
    await chmod(dir, 0o700).catch(() => {})
    return
  }
  await mkdirP(dir, { recursive: true, mode: 0o700 })
  const uid = process.getuid?.()
  const st = await lstat(dir)
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`refusing to use daemon dir: ${dir} is owned by uid ${st.uid}`)
  }
  if ((st.mode & 511) !== 448) await chmod(dir, 0o700)
}
