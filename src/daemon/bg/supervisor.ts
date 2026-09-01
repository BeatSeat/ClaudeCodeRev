import { mkdir, readdir, rm, unlink } from 'fs/promises'
import { watch } from 'chokidar'
import { createServer, type Socket } from 'net'
import { basename, join } from 'path'
import { freemem } from 'os'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode, isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  classifyAndWriteState,
  isSettled,
  readJobState,
  readPins,
  writeJobState,
} from './jobState.js'
import {
  authSnapshotPath,
  controlSock,
  dispatchDir,
  ensureDaemonDir,
  ensureRuntimeDaemonDir,
  jobDir,
  ptyDir,
  ptyPidsDir,
  rosterPath,
  runtimeDaemonDir,
  rvDir,
  sockErrPath,
  spareClaimSock,
  spareDir,
  sparePtySock,
  windowsPtyPidPath,
} from './paths.js'
import { killProcessGroup, procStart } from './procStart.js'
import { defaultSpawnPty } from './pty.js'
import {
  asMeta,
  bgEvent,
  featureBad,
  featureOk,
  featureSad,
  withFeatureSpan,
} from './telemetry.js'
import {
  DAEMON_PROTO,
  DispatchSchema,
  RosterSchema,
  type AuthSnapshot,
  type Dispatch,
  type Roster,
  type SpawnPty,
} from './types.js'
import { KF } from './worker.js'

declare const MACRO: { VERSION: string }

const RETIRE_GRACE_MS = 3600000
const LOW_MEM_GRACE_MS = 60000
const INTERVAL_MS = 60000
const EMPTY_PINNED = new Set<string>()
const STALE_DISPATCH_MS = 5 * 60 * 1000
const MAX_REQ = 8 << 20

function lowMemBytes(): number {
  if (getPlatform() === 'macos') return 0
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_bg_low_mem_mb', 1024) *
    1024 *
    1024
  )
}

function isLowMem(): boolean {
  const H = lowMemBytes()
  return H > 0 && freemem() < H
}

function bridgedGraceMs(): number {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_bg_retire_grace_bridged_min',
      480,
    ) * 60000
  )
}

function emptyRoster(): Roster {
  return {
    proto: DAEMON_PROTO,
    supervisorPid: process.pid,
    updatedAt: Date.now(),
    workers: {},
  }
}

async function readRoster(opts?: { silent?: boolean }): Promise<Roster> {
  let raw: unknown
  try {
    const { readFile } = await import('fs/promises')
    raw = safeParseJSON(await readFile(rosterPath(), 'utf8'))
  } catch (K) {
    if (isENOENT(K)) return emptyRoster()
    if (!opts?.silent) {
      logError(K)
      bgEvent('tengu_bg_roster_parse_failed', {
        orphaned: asMeta(-1),
        quarantined: asMeta(1),
      })
      await quarantineRoster()
    }
    return { ...emptyRoster(), parseFailed: true }
  }
  const q = RosterSchema.safeParse(raw)
  if (q.success) return q.data
  if (!opts?.silent) {
    logError(new Error(`roster.json parse failed: ${q.error.issues[0]?.message}`))
    bgEvent('tengu_bg_roster_parse_failed', {
      orphaned: asMeta(Object.keys((raw as { workers?: object })?.workers ?? {}).length),
      quarantined: asMeta(1),
    })
    await quarantineRoster()
  }
  return { ...emptyRoster(), parseFailed: true }
}

async function quarantineRoster(): Promise<void> {
  const { rename } = await import('fs/promises')
  await rename(rosterPath(), `${rosterPath()}.corrupt.${Date.now()}`).catch(
    () => {},
  )
}

async function writeRoster(roster: Roster): Promise<void> {
  const { mkdir: mkdirP, writeFile } = await import('fs/promises')
  const { dirname } = await import('path')
  await mkdirP(dirname(rosterPath()), { recursive: true, mode: 0o700 }).catch(
    () => {},
  )
  await writeFile(rosterPath(), jsonStringify(roster, null, 2), { mode: 0o600 })
}

let rosterQueue: Promise<unknown> = Promise.resolve()

function mutateRoster(fn: (roster: Roster) => void): Promise<void> {
  const next = rosterQueue.then(async () => {
    const q = await readRoster()
    fn(q)
    q.supervisorPid = process.pid
    q.updatedAt = Date.now()
    await writeRoster(q)
  })
  rosterQueue = next.catch(() => {})
  return next.then(() => {})
}

/** Official `G_q`. */
function wireHandle(
  handles: Map<string, KF>,
  worker: KF,
  onKeepAlive: () => void,
  pending: Set<Promise<unknown>>,
  log: (line: string) => void,
): void {
  const track = (A: Promise<unknown>) => {
    pending.add(A)
    A.finally(() => pending.delete(A))
  }
  worker.onSettle.subscribe(A => {
    log(`bg settled ${worker.record.short} (${A})`)
    const Y = jobDir(worker.record.short)
    const O = A === 'done' ? 'done' : A === 'killed' ? 'stopped' : 'failed'
    const f = worker.record.detail
    if (worker.shouldDeleteJobDir) {
      track(rm(Y, { recursive: true, force: true }).catch(M => logError(M)))
    } else {
      track(
        readJobState(Y)
          .then(M => {
            if (
              M
                ? (isSettled(M) && !(A === 'crashed' && M.state === 'failed')) ||
                  (A === 'done' &&
                    M.state === 'blocked' &&
                    worker.dispatch.launch.mode !== 'exec')
                : A !== 'crashed'
            ) {
              return
            }
            const j = new Date().toISOString()
            const w = M ?? {
              state: 'working',
              detail: '',
              tempo: 'active' as const,
              output: null,
              children: null,
              linkScanOffset: 0,
              template:
                worker.dispatch.launch.mode === 'exec'
                  ? 'exec'
                  : worker.dispatch.agent ?? worker.dispatch.routine ?? 'bg',
              routine: worker.dispatch.routine,
              respawnFlags: [...worker.dispatch.respawnFlags],
              intent: worker.record.intent,
              name: worker.record.name,
              sessionId: worker.record.sessionId,
              cwd: worker.record.cwd,
              worktreePath:
                worker.dispatch.worktree?.path ?? worker.record.worktreePath,
              createdAt: new Date(worker.dispatch.createdAt).toISOString(),
              updatedAt: j,
              firstTerminalAt: null,
              backend: 'daemon' as const,
            }
            return writeJobState(Y, {
              ...w,
              state: O,
              detail:
                O === 'stopped' ? 'stopped' : (f || w.detail).replace(/; respawning$/, ''),
              tempo: 'idle',
              inFlight: undefined,
              needs: undefined,
              block: undefined,
              updatedAt: j,
              firstTerminalAt: w.firstTerminalAt ?? j,
            })
          })
          .catch(M => logError(M)),
      )
    }
    track(
      mutateRoster(M => {
        delete M.workers[worker.record.short]
      }).catch(M => logError(M)),
    )
    if (getPlatform() === 'windows') {
      track(unlink(windowsPtyPidPath(worker.record.short)).catch(() => {}))
      track(unlink(sockErrPath(worker.ptySockPath ?? '')).catch(() => {}))
    } else {
      track(unlink(authSnapshotPath(worker.record.short)).catch(() => {}))
      const M = worker.rosterEntry()
      track(unlink(M.rendezvousSock).catch(() => {}))
      if (M.ptySock) {
        track(unlink(M.ptySock).catch(() => {}))
        track(unlink(sockErrPath(M.ptySock)).catch(() => {}))
      }
    }
    if (worker.dispatch.launch.mode === 'exec' && A !== 'killed') {
      onKeepAlive()
      setTimeout(
        (j: Map<string, KF>, w: string, D: KF) => {
          if (j.get(w) === D) j.delete(w)
        },
        300000,
        handles,
        worker.record.short,
        worker,
      ).unref()
      return
    }
    handles.delete(worker.record.short)
    onKeepAlive()
  })
  worker.onState.subscribe(A => {
    if (A.pid) {
      void mutateRoster(Y => {
        Y.workers[worker.record.short] = worker.rosterEntry()
      }).catch(Y => logError(Y))
    }
    if (A.state === 'crashed' || A.state === 'resuming') {
      const Y = A.state
      const O = worker.record.detail
      const f = Y === 'crashed' ? 'idle' : 'active'
      const M = jobDir(worker.record.short)
      void readJobState(M)
        .then(j => {
          if (worker.record.outcome || !j || isSettled(j) || j.state === 'blocked')
            return
          if (Y === 'resuming' && j.state !== 'crashed') return
          return writeJobState(M, {
            ...j,
            state: Y,
            detail: O,
            tempo: f,
            inFlight: undefined,
            updatedAt: new Date().toISOString(),
          })
        })
        .catch(j => logError(j))
    }
  })
}

function writeJson(sock: Socket, payload: unknown): void {
  if (sock.destroyed) return
  sock.end(jsonStringify(payload) + '\n')
}

/** Official `v09` lease TCP server (ops used by I09). */
async function startLeaseServer(
  handles: Map<string, KF>,
  dispatch: (d: Dispatch, n?: number, afterUpgrade?: boolean) => void,
  onNudge: () => Promise<boolean>,
  onShutdown: (reap: boolean) => number,
  isReady: () => boolean,
  onYield: () => boolean,
): Promise<{
  close: () => Promise<void>
  leaseCount: () => number
  onLeaseChange: { subscribe: (fn: () => void) => () => void }
}> {
  await ensureRuntimeDaemonDir()
  const { unlink: unlinkP } = await import('fs/promises')
  const addr = controlSock()
  await unlinkP(addr).catch(() => {})
  const conns = new Set<Socket>()
  const leases = new Map<Socket, { label?: string } | undefined>()
  const onLeaseChange = {
    listeners: new Set<() => void>(),
    subscribe(fn: () => void) {
      this.listeners.add(fn)
      return () => {
        this.listeners.delete(fn)
      }
    },
    emit() {
      for (const l of this.listeners) l()
    },
  }
  const addLease = (D: Socket, J?: { label?: string }) => {
    if (leases.has(D)) return
    leases.set(D, J)
    bgEvent('tengu_daemon_lease', {
      op: asMeta('open'),
      label: asMeta(J?.label ?? ''),
    })
    D.once('close', () => {
      leases.delete(D)
      bgEvent('tengu_daemon_lease', {
        op: asMeta('close'),
        label: asMeta(J?.label ?? ''),
      })
      onLeaseChange.emit()
    })
    onLeaseChange.emit()
  }
  const clients = () => {
    const D: { label?: string }[] = []
    for (const J of leases.values()) if (J) D.push(J)
    return D
  }
  const server = createServer(D => {
    D.on('error', () => D.destroy())
    D.setTimeout(30000, () => D.destroy())
    conns.add(D)
    D.once('close', () => conns.delete(D))
    let X = Buffer.alloc(0)
    const L = (P: Buffer) => {
      X = Buffer.concat([X, P])
      const G = X.indexOf(10)
      if (G < 0) {
        if (X.length > MAX_REQ) {
          D.off('data', L)
          writeJson(D, {
            ok: false,
            code: 'ETOOLARGE',
            error: `request exceeds ${MAX_REQ >> 20}MB — shorten the prompt or send in parts`,
          })
        }
        return
      }
      D.off('data', L)
      D.setTimeout(0)
      const W = X.subarray(0, G).toString('utf8')
      void ingestControl(D, W, {
        handles,
        dispatch,
        onNudge,
        onShutdown,
        isReady,
        onYield,
        addLease,
        clients,
      }).catch(V => {
        writeJson(D, {
          ok: false,
          error: V instanceof Error ? V.message : String(V),
          code: 'EUNKNOWN',
        })
      })
    }
    D.on('data', L)
  })
  server.on('error', D => logError(D))
  await new Promise<void>((D, J) => {
    server.once('error', J)
    server.listen(addr, () => {
      server.removeListener('error', J)
      D()
    })
  })
  return {
    close: () =>
      new Promise(D => {
        for (const J of conns) J.destroy()
        server.close(() => {
          void unlinkP(addr).catch(() => {})
          D()
        })
      }),
    leaseCount: () => leases.size,
    onLeaseChange,
  }
}

async function ingestControl(
  sock: Socket,
  line: string,
  ctx: {
    handles: Map<string, KF>
    dispatch: (d: Dispatch, n?: number, afterUpgrade?: boolean) => void
    onNudge: () => Promise<boolean>
    onShutdown: (reap: boolean) => number
    isReady: () => boolean
    onYield: () => boolean
    addLease: (s: Socket, c?: { label?: string }) => void
    clients: () => { label?: string }[]
  },
): Promise<void> {
  let j: { op?: string; proto?: number; reapWorkers?: boolean; client?: { label?: string } }
  try {
    j = JSON.parse(line) as typeof j
  } catch {
    return writeJson(sock, { ok: false, error: 'bad json', code: 'EUNKNOWN' })
  }
  if (j === null || typeof j !== 'object') {
    return writeJson(sock, { ok: false, error: 'bad json', code: 'EUNKNOWN' })
  }
  const w = j.op
  if (w === 'ping') {
    return writeJson(sock, { ok: true, op: 'ping', version: MACRO.VERSION, proto: DAEMON_PROTO })
  }
  if (w === 'nudge') {
    return writeJson(sock, {
      ok: true,
      op: 'nudge',
      restarting: await ctx.onNudge(),
      version: MACRO.VERSION,
    })
  }
  if (w === 'yield') {
    return writeJson(sock, { ok: true, op: 'yield', yielding: ctx.onYield() })
  }
  if (w === 'lease') {
    ctx.addLease(sock, j.client)
    sock.write(jsonStringify({ ok: true, op: 'lease' }) + '\n')
    return
  }
  if (w === 'leases') {
    return writeJson(sock, { ok: true, op: 'leases', clients: ctx.clients() })
  }
  if (w === 'shutdown') {
    const L = j.reapWorkers !== false
    const P = ctx.onShutdown(L)
    return writeJson(sock, { ok: true, op: 'shutdown', reaped: P })
  }
  if (!ctx.isReady()) {
    return writeJson(sock, {
      ok: false,
      error: 'background service starting (adoption in progress)',
      code: 'ESTARTING',
    })
  }
  const D = j.proto
  if (typeof D !== 'number' || !Number.isInteger(D) || D < 1 || D > DAEMON_PROTO) {
    bgEvent('tengu_bg_proto_mismatch', {
      client_proto: asMeta(typeof D === 'number' ? D : -1),
      server_proto: asMeta(DAEMON_PROTO),
    })
    return writeJson(sock, {
      ok: false,
      error: `proto mismatch (server=${DAEMON_PROTO}, client=${D}) — background service and CLI versions differ; restart claude`,
      code: 'EPROTO',
      serverProto: DAEMON_PROTO,
      serverVersion: MACRO.VERSION,
    })
  }
  writeJson(sock, { ok: false, error: 'unknown op', code: 'EUNKNOWN' })
}

function isTmpName(name: string): boolean {
  return name.endsWith('.tmp') || name.includes('.tmp.')
}

async function ingestDispatch(
  path: string,
  dispatch: (d: Dispatch) => void,
): Promise<void> {
  let q
  try {
    const { lstat } = await import('fs/promises')
    q = await lstat(path)
  } catch (Y) {
    if (isENOENT(Y)) return
    featureBad('daemon_bg_dispatch_ingest', 'read_failed')
    return
  }
  if (q.isSymbolicLink()) {
    featureBad('daemon_bg_dispatch_ingest', 'symlink')
    return
  }
  if (q.size > 1024 * 1024) {
    featureBad('daemon_bg_dispatch_ingest', 'oversized')
    return
  }
  let K: string
  try {
    const { readFile } = await import('fs/promises')
    K = await readFile(path, 'utf8')
  } catch (Y) {
    if (isENOENT(Y)) return
    featureBad('daemon_bg_dispatch_ingest', 'read_failed')
    return
  }
  let parsed: unknown
  let z = true
  try {
    parsed = JSON.parse(K)
  } catch {
    parsed = undefined
    z = false
  }
  const A = DispatchSchema.safeParse(parsed)
  if (!A.success) {
    featureBad('daemon_bg_dispatch_ingest', z ? 'schema' : 'bad_json')
    return
  }
  if (Date.now() - A.data.createdAt > STALE_DISPATCH_MS) {
    featureBad('daemon_bg_dispatch_ingest', 'stale')
    return
  }
  dispatch(A.data)
  featureOk('daemon_bg_dispatch_ingest')
  await unlink(path).catch(() => {})
}

async function drainDispatch(dispatch: (d: Dispatch) => void): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dispatchDir())
  } catch (q) {
    if (isENOENT(q)) return
    throw q
  }
  for (const q of names) {
    if (q.startsWith('.') || isTmpName(q) || q === 'rejected') continue
    await ingestDispatch(join(dispatchDir(), q), dispatch)
  }
}

async function startWatcher(
  dispatch: (d: Dispatch) => void,
): Promise<{ close: () => Promise<void> }> {
  return withFeatureSpan('daemon_bg_watcher_start', async () => {
    await mkdir(dispatchDir(), { recursive: true, mode: 0o700 }).catch(() => {})
    const plat = getPlatform()
    const macos = plat === 'macos'
    const K = watch(dispatchDir(), {
      ignoreInitial: true,
      depth: 0,
      usePolling: macos,
      interval: 100,
      ignored: (_: string) =>
        isTmpName(basename(_)) || basename(_) === 'rejected',
      ...(plat === 'windows'
        ? { awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 } }
        : {}),
    })
    K.on('add', _ => {
      void ingestDispatch(_, dispatch).catch(z =>
        logForDebugging(`[bg-dispatch] ${z}`, { level: 'error' }),
      )
    })
    K.on('error', _ => {
      logForDebugging(`[bg-dispatch] watcher error: ${_}`, { level: 'error' })
      bgEvent('tengu_bg_dispatch_watcher_failed', {
        errno: asMeta(getErrnoCode(_) ?? 'unknown'),
      })
    })
    await Promise.race([
      new Promise<void>(r => K.on('ready', () => r())),
      new Promise<void>(r => setTimeout(r, 5000)),
    ]).catch(_ =>
      logForDebugging(`[bg-dispatch] watcher ready wait: ${_}`),
    )
    await drainDispatch(dispatch).catch(_ => {
      logForDebugging(`[bg-dispatch] cold-start drain: ${_}`, { level: 'error' })
      bgEvent('tengu_bg_dispatch_watcher_failed', {
        errno: asMeta(getErrnoCode(_) ?? 'unknown'),
      })
    })
    return { close: () => K.close() }
  })
}

type Spare = {
  pid: number
  ptySockPath: string
  startedAt: number
  cliVersion: string
  spawnPty: SpawnPty
  dispose: () => void
}

function spawnSpare(log: (line: string) => void, onExit: () => void): Promise<Spare | null> {
  if (getPlatform() === 'windows') return Promise.resolve(null)
  return withFeatureSpan('daemon_bg_spare_refill', async () => {
    const { randomBytes } = await import('crypto')
    const $ = randomBytes(4).toString('hex')
    const q = sparePtySock($)
    const K = spareClaimSock($)
    const { unlink: unlinkP } = await import('fs/promises')
    await mkdir(spareDir(), { recursive: true, mode: 0o700 }).catch(() => {})
    await unlinkP(q).catch(() => {})
    await unlinkP(K).catch(() => {})
    const spec = (await import('../../utils/relaunch.js')).getRelaunchSpec({
      pinToCurrentBinary: true,
    })
    const A = Bun.spawn(
      [
        spec.cmd,
        ...spec.prefixArgs,
        '--bg-pty-host',
        q,
        '200',
        '50',
        '--',
        spec.cmd,
        ...spec.prefixArgs,
        '--bg-spare',
        K,
      ],
      {
        cwd: spareDir(),
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      },
    )
    A.unref()
    const Y: Spare = {
      pid: A.pid,
      ptySockPath: q,
      startedAt: Date.now(),
      cliVersion: MACRO.VERSION,
      spawnPty: defaultSpawnPty(),
      dispose() {
        try {
          A.kill('SIGTERM')
        } catch {
          /* ignore */
        }
      },
    }
    void A.exited.then(() => {
      void unlinkP(q).catch(() => {})
      void unlinkP(K).catch(() => {})
      void unlinkP(sockErrPath(q)).catch(() => {})
      onExit()
    })
    log(`bg spare spawned host pid=${A.pid}`)
    return Y
  })
}

export type BgManager = {
  handles: Map<string, KF>
  dispatch: (d: Dispatch) => void
  leaseCount: () => number
  liveHandleCount: () => number
  pendingSettleWrites: () => number
  killAll: (sig?: string) => number
  close: () => Promise<void>
  workerCount: () => number
}

/**
 * Official 2.1.153 `I09` / `daemon_bg_manager_start`.
 */
export async function startBgManager(
  log: (line: string) => void,
  opts: {
    getAuthSnapshot?: () => AuthSnapshot | undefined
    onNudge?: () => Promise<boolean>
    onShutdown?: () => void
    onYield?: () => boolean
    onKeepAliveChange?: () => void
    spawnPty?: SpawnPty
  } = {},
): Promise<BgManager> {
  return withFeatureSpan('daemon_bg_manager_start', async () => {
    const q = new Map<string, KF>()
    const K = new Set<Promise<unknown>>()
    const _ = opts.spawnPty ?? defaultSpawnPty()
    const z = opts.onKeepAliveChange ?? (() => {})
    let A = false
    let Y = false
    let O: Spare | null = null
    let f = false
    let M = false
    const j = opts.spawnPty === undefined
    const refillSpare = () => {
      if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_bg_spare_enable', true)) {
        if (O) {
          O.dispose()
          O = null
        }
        return
      }
      const E = lowMemBytes()
      if (E > 0 && freemem() < E) {
        if (O) {
          O.dispose()
          O = null
        }
        return
      }
      if (!M || O || f || A || !Y || !_ || !j || getPlatform() === 'windows') {
        return
      }
      f = true
      let S: Spare | null = null
      let h = false
      void spawnSpare(log, () => {
        if (S === null) {
          h = true
          return
        }
        if (O === S) {
          O = null
          if (Date.now() - S.startedAt >= 2000) refillSpare()
        }
      })
        .then(I => {
          S = I
          if (!I || A || h) {
            I?.dispose()
            return
          }
          O = I
          bgEvent('tengu_bg_spare_spawn', {})
        })
        .catch(I => {
          logForDebugging(
            `bg-spare spawn failed: ${getErrnoCode(I)} ${I instanceof Error ? I.message : String(I)}`,
            { level: 'warn' },
          )
        })
        .finally(() => {
          f = false
        })
    }
    const D = (E: Dispatch, S = 0, h?: boolean) => {
      if (A) return
      M = true
      const I = q.get(E.short)
      if (I) {
        if ((I.isKilling || I.isRetiring || I.record.outcome) && S < 30) {
          if (S === 15 && (I.isKilling || I.isRetiring)) {
            bgEvent('tengu_bg_dispatch_sigkill_escalate', {})
            I.kill('SIGKILL')
          }
          setTimeout(D, 100, E, S + 1, h)
          return
        }
        const R = I.isKilling || I.isRetiring || I.record.outcome
        log(
          R
            ? `bg: dispatch ${E.short} dropped — retry budget exhausted (handle still settling)`
            : `bg: dup dispatch ${E.short} dropped (existing handle still live)`,
        )
        if (R) featureBad('daemon_bg_session_create', 'dup_retry_exhausted')
        else featureOk('daemon_bg_session_create')
        return
      }
      const C = freemem()
      const b = lowMemBytes()
      if (b > 0 && C < b && q.size > 0) {
        const R = Math.round(C / 1024 / 1024)
        log(
          `bg: low memory (${R}MB free) — retiring settled workers before spawning ${E.short}`,
        )
        bgEvent('tengu_bg_dispatch_low_mem', {
          free_mb: asMeta(R),
          handles: asMeta(q.size),
        })
        void readPins()
          .catch(x => {
            logError(x)
            return new Set<string>()
          })
          .then(x => {
            for (const U of q.values()) {
              void U.retireIfSettled(LOW_MEM_GRACE_MS, x).catch(Q => logError(Q))
            }
          })
      }
      if (E.source === 'spare' && b > 0 && C < b) {
        log(`bg: low memory — skipping spare dispatch ${E.short}`)
        return
      }
      if (
        O &&
        !h &&
        E.launch.mode !== 'exec' &&
        O.cliVersion === MACRO.VERSION &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_bg_spare_enable', true)
      ) {
        const R = O
        O = null
        try {
          const x = KF.claim(E, {
            spawnPty: R.spawnPty,
            getAuthSnapshot: opts.getAuthSnapshot,
            pid: R.pid,
            ptySockPath: R.ptySockPath,
            startedAt: R.startedAt,
          })
          q.set(E.short, x)
          wireHandle(q, x, z, K, log)
          z()
          bgEvent('tengu_bg_spare_claim', {
            age_ms: asMeta(Date.now() - R.startedAt),
          })
          log(`bg claimed-spare ${E.short} (${E.source})`)
          featureOk('daemon_bg_session_create')
          refillSpare()
          return
        } catch (x) {
          const U = getErrnoCode(x)
          const Q =
            U === 'ENOENT'
              ? 'enoent'
              : U === 'ECONNREFUSED'
                ? 'econnrefused'
                : x instanceof Error
                  ? 'error'
                  : 'unknown'
          bgEvent('tengu_bg_spare_claim_fail', { reason: asMeta(Q) })
          R.dispose()
        }
      }
      const m = KF.spawn(E, _, opts.getAuthSnapshot, h ? { afterUpgrade: h } : undefined)
      q.set(E.short, m)
      wireHandle(q, m, z, K, log)
      z()
      refillSpare()
      log(`bg spawned ${E.short} (${E.source})`)
      featureOk('daemon_bg_session_create')
    }
    const J = (E = 'SIGTERM') => {
      let S = 0
      for (const h of q.values()) {
        if (!h.record.outcome) {
          h.kill(E)
          S++
        }
      }
      return S
    }
    await ensureRuntimeDaemonDir()
    await ensureDaemonDir()
    const X = await startLeaseServer(
      q,
      D,
      opts.onNudge ?? (async () => false),
      E => {
        const S = E ? J('SIGTERM') : 0
        opts.onShutdown?.()
        return S
      },
      () => Y,
      opts.onYield ?? (() => false),
    )
    X.onLeaseChange.subscribe(z)
    X.onLeaseChange.subscribe(() => {
      if (X.leaseCount() > 0 && !M) {
        M = true
        refillSpare()
      }
    })
    await Promise.all(
      getPlatform() === 'windows'
        ? [mkdir(ptyPidsDir(), { recursive: true }).catch(() => {})]
        : [
            mkdir(rvDir(), { recursive: true, mode: 0o700 }).catch(() => {}),
            mkdir(ptyDir(), { recursive: true, mode: 0o700 }).catch(() => {}),
          ],
    )
    const L = await readRoster()
    let P = 0
    let G = 0
    let W = 0
    await Promise.all(
      Object.entries(L.workers).map(async ([E, S]) => {
        let h: KF | null
        try {
          h = await KF.adopt(E, S, _, opts.getAuthSnapshot)
        } catch (I) {
          logError(I)
          G++
          return
        }
        if (h) {
          q.set(E, h)
          wireHandle(q, h, z, K, log)
          P++
        } else if (S.pendingRespawn === 'upgrade') {
          W++
          bgEvent('tengu_bg_adopt_upgrade_respawn', {})
          D(S.dispatch, 0, true)
        } else {
          G++
          void classifyAndWriteState(E, 'failed', 'process gone while supervisor was down')
          if (getPlatform() === 'windows') {
            void unlink(windowsPtyPidPath(E)).catch(() => {})
          } else {
            void unlink(authSnapshotPath(E)).catch(() => {})
            void unlink(S.rendezvousSock).catch(() => {})
            if (S.ptySock) {
              void unlink(S.ptySock).catch(() => {})
              void unlink(sockErrPath(S.ptySock)).catch(() => {})
              try {
                process.kill(S.pid, 0)
              } catch {
                killProcessGroup([-S.pid])
              }
            }
          }
        }
      }),
    )
    if (P + G + W > 0) {
      log(`bg adopt: adopted=${P} respawned=${W} dead=${G}`)
      bgEvent('tengu_bg_adopt', {
        adopted: asMeta(P),
        respawned: asMeta(W),
        dead: asMeta(G),
      })
      if (G === 0) featureOk('daemon_bg_adopt')
      else if (P > 0 || W > 0) featureSad('daemon_bg_adopt', 'partial')
      else featureBad('daemon_bg_adopt', 'all_workers_dead')
    }
    await mutateRoster(E => {
      E.workers = {}
      for (const [S, h] of q) E.workers[S] = h.rosterEntry()
    }).catch(E => logError(E))
    const Z = await startWatcher(D)
    Y = true
    z()
    if (q.size > 0) M = true
    refillSpare()
    let V = Date.now()
    const v = setInterval(
      async (E: Map<string, KF>, S: () => void) => {
        const h = Date.now()
        const I = h - V - INTERVAL_MS
        if (((V = h), I > INTERVAL_MS)) {
          for (const Q of E.values()) Q.shiftGraceClocksForward(I)
          S()
          return
        }
        const C = isLowMem()
        const b = C ? LOW_MEM_GRACE_MS : RETIRE_GRACE_MS
        const m = C ? LOW_MEM_GRACE_MS : bridgedGraceMs()
        const R = await readPins().catch(Q => {
          logError(Q)
          return new Set<string>()
        })
        for (const Q of E.values()) {
          if (R.has(Q.dispatch.short)) {
            void Q.respawnIfIdleStale(R).catch(g => logError(g))
          }
        }
        const x = await Promise.all(
          [...E.values()].map(Q =>
            Q.retireIfSettled(b, R, m)
              .then(g => g.retired)
              .catch(g => {
                logError(g)
                return false
              }),
          ),
        )
        const U = x.filter(Q => Q).length
        if (C && U === 0 && isLowMem()) {
          const Q = [...E.values()].filter(g => R.has(g.dispatch.short))
          if (Q.length > 0) {
            log(
              'bg: low memory persists after shedding non-pinned — retiring pinned settled workers as a last resort',
            )
            bgEvent('tengu_bg_retire_pinned_low_mem', {})
            for (const g of Q) {
              void g.retireIfSettled(b, EMPTY_PINNED, m).catch(l => logError(l))
            }
          }
        }
        S()
      },
      INTERVAL_MS,
      q,
      refillSpare,
    )
    v.unref()
    return {
      handles: q,
      dispatch: (E: Dispatch) => D(E),
      leaseCount: X.leaseCount,
      liveHandleCount: () => {
        let E = 0
        for (const S of q.values()) if (!S.record.outcome) E++
        return E
      },
      pendingSettleWrites: () => K.size,
      killAll: J,
      workerCount: () => q.size,
      close: async () => {
        A = true
        clearInterval(v)
        if (O) {
          O.dispose()
          O = null
        }
        await Promise.all([Z.close().catch(() => {}), X.close().catch(() => {})])
        for (const E of q.values()) E.stop()
        await Promise.allSettled([...K])
        if (q.size === 0 && !L.parseFailed && getPlatform() !== 'windows') {
          await rm(runtimeDaemonDir(), { recursive: true, force: true }).catch(
            () => {},
          )
        }
      },
    }
  })
}
