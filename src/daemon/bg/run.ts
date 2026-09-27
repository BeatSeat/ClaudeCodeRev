import { readFile, unlink, writeFile } from 'fs/promises'
import { createWriteStream, type WriteStream } from 'fs'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode, isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { getRelaunchSpec } from '../../utils/relaunch.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { daemonLockPath, daemonLogPath } from './paths.js'
import { pidStartMatchesAsync, procStart } from './procStart.js'
import { startBgManager, type BgManager } from './supervisor.js'
import { asMeta, bgEvent, featureOk, featureSad } from './telemetry.js'
import type { DaemonOrigin } from './types.js'

declare const MACRO: { VERSION: string }

const UPGRADE_POLL_MS = 60000
const IDLE_GRACE_MS = 5000
const LOG_ROTATE = 10485760

type LockInfo = {
  pid: number
  version: string
  origin?: string
  startedAt?: number
  procStart?: string
  jsonPath?: string
  logPath?: string
  spawnedBy?: unknown
  launchTarget?: string
}

/** Official 2.1.119 — no env/settings disable (those tokens are later hops). */
export function isBackgroundAgentsDisabled(): boolean {
  return false
}

async function readLock(): Promise<LockInfo | null> {
  let H: string
  try {
    H = await readFile(daemonLockPath(), 'utf8')
  } catch (q) {
    if (isENOENT(q)) return null
    throw q
  }
  const $ = safeParseJSON(H)
  if ($ && typeof $ === 'object') {
    const q = $ as LockInfo
    if (typeof q.pid === 'number' && typeof q.version === 'string') return q
  }
  return null
}

/** Official `I2`. */
async function livingLock(): Promise<LockInfo | null> {
  const H = await readLock()
  if (!H) return null
  try {
    process.kill(H.pid, 0)
  } catch {
    return null
  }
  try {
    process.kill(H.pid, 0)
  } catch {
    return null
  }
  if (!(await pidStartMatchesAsync(H.pid, H.procStart))) return null
  return H
}

async function tryWriteLock(H: LockInfo): Promise<boolean> {
  try {
    await writeFile(daemonLockPath(), jsonStringify(H, null, 2), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

async function replaceLock(H: LockInfo): Promise<boolean> {
  const tmp = `${daemonLockPath()}.tmp.${H.pid}.${H.startedAt}`
  await writeFile(tmp, jsonStringify(H, null, 2), { flag: 'wx' })
  try {
    await writeFile(daemonLockPath(), jsonStringify(H, null, 2))
    await unlink(tmp).catch(() => {})
    return true
  } catch (K) {
    const _ = getErrnoCode(K)
    if (_ === 'EEXIST' || _ === 'EPERM') {
      await unlink(daemonLockPath()).catch(() => {})
      try {
        const { rename } = await import('fs/promises')
        await rename(tmp, daemonLockPath())
        return true
      } catch {
        await unlink(tmp).catch(() => {})
        return false
      }
    }
    await unlink(tmp).catch(() => {})
    return false
  }
}

async function releaseLock(info: LockInfo): Promise<void> {
  const cur = await readLock().catch(() => null)
  if (cur && cur.pid === info.pid && cur.startedAt === info.startedAt) {
    await unlink(daemonLockPath()).catch(() => {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(K => {
    const z = setTimeout(K, ms)
    z.unref()
  })
}

type DaemonLog = {
  write: (z: string, A: string) => void
  close: () => Promise<void>
}

/** Official `u09`. */
async function openDaemonLog(path: string): Promise<DaemonLog> {
  const tty = process.stdout.isTTY
  let q = await import('fs/promises')
    .then(fs => fs.stat(path).then(z => z.size))
    .catch(() => 0)
  if (q > LOG_ROTATE) {
    await rotateLog(path)
    q = 0
  }
  let K = createWriteStream(path, { flags: 'a' })
  K.on('error', () => {})
  let rotating = false
  return {
    write(z, A) {
      const Y = `[${new Date().toISOString()}] [${z}] ${A}\n`
      q += Buffer.byteLength(Y)
      K.write(Y)
      if (tty) process.stdout.write(Y)
      if (q > LOG_ROTATE && !rotating) {
        rotating = true
        const O = K
        void (async () => {
          if (getPlatform() === 'windows') {
            await endStream(O)
            await rotateLog(path)
            K = createWriteStream(path, { flags: 'a' })
            K.on('error', () => {})
          } else {
            await rotateLog(path)
            K = createWriteStream(path, { flags: 'a' })
            K.on('error', () => {})
            await endStream(O)
          }
          q = 0
          rotating = false
        })().catch(() => {
          rotating = false
        })
      }
    },
    close() {
      return endStream(K)
    },
  }
}

function endStream(H: WriteStream): Promise<void> {
  return new Promise(r => H.end(() => r()))
}

async function rotateLog(H: string): Promise<void> {
  const $ = `${H}.1`
  try {
    const { rename } = await import('fs/promises')
    await rename(H, $)
  } catch (q) {
    if (isENOENT(q)) return
    await unlink($).catch(() => {})
    const { rename } = await import('fs/promises')
    await rename(H, $).catch(() => unlink(H).catch(() => {}))
  }
}

export type RunDaemonResult = { upgradeDetected: boolean; exitCode: number }

/**
 * Official 2.1.153 `l09`.
 */
export async function runDaemonSupervisor(H: {
  jsonPath: string
  logPath: string
  origin: DaemonOrigin
  spawnedBy?: unknown
  signal: AbortSignal
}): Promise<RunDaemonResult> {
  const { jsonPath: $, logPath: q, origin: K, spawnedBy: _, signal: z } = H
  const M = await openDaemonLog(q)
  M.write(
    'supervisor',
    `─── daemon start ─── version=${MACRO.VERSION} pid=${process.pid} origin=${K}`,
  )
  let j = await livingLock()
  let w = false
  if (j && j.origin === 'transient' && K !== 'transient') {
    w = true
    M.write(
      'supervisor',
      `transient daemon running (pid=${j.pid}, origin=transient) — asking it to yield to origin=${K}`,
    )
    /* official `Cf({proto, op:"yield"})` — no live control client in-tree yet */
    M.write(
      'supervisor',
      `existing daemon unreachable on control socket; not taking over`,
    )
  }
  if (j) {
    const l = w
      ? `origin=${j.origin ?? 'unknown'}; asked it to yield but the handover failed (see above)`
      : K === 'transient'
        ? `origin=${j.origin ?? 'unknown'}; an on-demand daemon never displaces a running one`
        : `origin=${j.origin ?? 'unknown'}; only a transient daemon can be displaced`
    const d =
      getPlatform() === 'windows'
        ? `Stop it with \`taskkill /PID ${j.pid}\`, then retry.`
        : 'Run `claude daemon stop` to stop it, then retry.'
    M.write(
      'supervisor',
      `another daemon is already running (pid=${j.pid}, version=${j.version}, ${l}). ${d}`,
    )
    if (w) featureSad('daemon_start', 'daemon_start_yield_failed')
    else featureOk('daemon_start')
    await M.close()
    return { upgradeDetected: false, exitCode: 1 }
  }
  const D = getRelaunchSpec({ pinToCurrentBinary: true })
  const J = D.prefixArgs[0] ?? D.cmd
  const L: LockInfo = {
    pid: process.pid,
    version: MACRO.VERSION,
    jsonPath: $,
    logPath: q,
    startedAt: Date.now(),
    origin: K,
    spawnedBy: _,
    procStart: await procStart(process.pid),
    launchTarget: J,
  }
  let P = await tryWriteLock(L)
  if (!P) {
    const l = await readLock()
    if (l) {
      let d = false
      try {
        process.kill(l.pid, 0)
        d = (await pidStartMatchesAsync(l.pid, l.procStart)) && true
      } catch (r) {
        if (getErrnoCode(r) !== 'ESRCH') d = true
      }
      if (d) {
        M.write(
          'supervisor',
          `another daemon won the lock race (pid=${l.pid}) — exiting`,
        )
        featureOk('daemon_start')
        await M.close()
        return { upgradeDetected: false, exitCode: 1 }
      }
      P = await replaceLock(L)
    } else P = await replaceLock(L)
    if (!P) {
      M.write('supervisor', 'another daemon won the lock race — exiting')
      featureOk('daemon_start')
      await M.close()
      return { upgradeDetected: false, exitCode: 1 }
    }
  }
  let Z = false
  let V = false
  let E = false
  let S: (() => void) | null = null
  const h = () => {
    if (K !== 'transient') return false
    if (!E) {
      E = true
      M.write(
        'supervisor',
        'yielding to a foreground/service daemon — bg workers will be re-adopted',
      )
      bgEvent('tengu_daemon_yield', {})
      S?.()
    }
    return true
  }
  const C: { manager: BgManager | null } = { manager: null }
  let b: ReturnType<typeof setTimeout> | null = null
  let m = false
  const R = () =>
    (C.manager?.leaseCount() ?? 0) + (C.manager?.liveHandleCount() ?? 0)
  const x = () => {
    if (K !== 'transient') return
    if (m || Z || V || E || z.aborted) return
    if (R() > 0) {
      if (b) {
        clearTimeout(b)
        b = null
      }
      return
    }
    if (b) return
    b = setTimeout(() => {
      if (b) b = null
      if (z.aborted || Z || R() > 0) return
      m = true
      const l = C.manager?.workerCount() ?? 0
      M.write(
        'supervisor',
        `idle ${Math.round(IDLE_GRACE_MS / 1000)}s with no clients — exiting` +
          (l > 0 ? ` (stopping ${l} configured workers)` : ''),
      )
      bgEvent('tengu_daemon_idle_exit', {
        grace_ms: asMeta(IDLE_GRACE_MS),
        cfg_workers: asMeta(l),
      })
      S?.()
    }, IDLE_GRACE_MS)
    b.unref()
  }
  void startBgManager(l => M.write('bg', l), {
    getAuthSnapshot: K === 'service' ? () => undefined : undefined,
    onNudge: async () => false,
    onShutdown: () => {
      V = true
      M.write('supervisor', 'shutdown requested via control socket')
      S?.()
    },
    onYield: h,
    onKeepAliveChange: x,
  })
    .then(l => {
      if (z.aborted) {
        void l.close()
        return
      }
      C.manager = l
      x()
    })
    .catch(logError)
  const U = 0
  M.write('supervisor', `workers=${U}`)
  bgEvent('tengu_daemon_start', {
    worker_kinds: asMeta(0),
    worker_count: asMeta(U),
    origin: asMeta(K),
  })
  featureOk('daemon_start')
  x()
  await new Promise<void>(l => {
    S = l
    if (z.aborted || Z || m || V || E) {
      l()
      return
    }
    z.addEventListener('abort', () => l(), { once: true })
    const d = setInterval(() => {
      if (z.aborted || Z || V) {
        clearInterval(d)
        return
      }
    }, UPGRADE_POLL_MS)
    d.unref()
  })
  S = null
  if (b) {
    clearTimeout(b)
    b = null
  }
  if (Z) bgEvent('tengu_daemon_self_restart_on_upgrade', {})
  M.write('supervisor', 'shutting down')
  if (E) {
    await C.manager?.close()
    C.manager = null
  }
  if (m || V || E) {
    await releaseLock(L)
    if (V) C.manager?.killAll('SIGTERM')
  }
  await Promise.all([C.manager?.close()])
  await releaseLock(L)
  await M.close()
  return { upgradeDetected: Z, exitCode: 0 }
}

export { daemonLogPath, getClaudeConfigHomeDir }
export function defaultDaemonJsonPath(): string {
  return `${getClaudeConfigHomeDir()}/daemon.json`
}

export function defaultDaemonLogPath(): string {
  return daemonLogPath()
}
