import { accessSync } from 'fs'
import { access, mkdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { open } from 'fs/promises'
import { getRelaunchSpec } from '../../utils/relaunch.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode, isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { createDecModes } from './decModes.js'
import { createDaemonSignal } from './events.js'
import { bridgeReattachEnv, isSettled, readJobState } from './jobState.js'
import {
  jobDir,
  ptySock as ptySockPathFor,
  rendezvousSock,
  windowsPtyPidPath,
} from './paths.js'
import { procStart, procStartSync } from './procStart.js'
import { connectPty, defaultSpawnPty } from './pty.js'
import { connectRendezvous, detachOsc } from './rendezvous.js'
import { workerArgv, workerEnv, writeAuthSnapshot } from './spawnArgs.js'
import { asMeta, bgEvent } from './telemetry.js'
import type {
  AuthSnapshot,
  Dispatch,
  PtyHandle,
  RosterEntry,
  SpawnPty,
  WorkerPhase,
  WorkerRecord,
} from './types.js'

declare const MACRO: { VERSION: string }

const BACKOFF_MS = 10000
const MAX_ATTEMPTS = 20
const FAST_CRASH_MS = 5000
const PREINIT_TAIL = 200
const PID_POLL_MS = 5000
const STALL_MS = 120000
const RECENT_ADOPT_MS = 120000
const EMPTY_IDLE_MS = 300000
const CAPPED_STR = 4096
const RING_CAP = 262144
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
const DETACH_OSC = '\x1b_cc-daemon-detach\x1b\\'

function phaseName(p: WorkerPhase): string {
  if (p.kind === 'retiring') return `retiring:${p.reason}`
  if (p.kind === 'retired') return `retired:${p.outcome}`
  return p.kind
}

/** Official `tJz`. */
function canTransition(from: WorkerPhase, to: WorkerPhase): boolean {
  if (from.kind === 'retired') return false
  switch (to.kind) {
    case 'spawning':
      return from.kind === 'upgrading' || from.kind === 'running'
    case 'running':
      return from.kind === 'spawning'
    case 'upgrading':
      return from.kind === 'running'
    case 'retiring':
    case 'retired':
      return true
  }
}

async function realpathNfc(cwd: string): Promise<string> {
  try {
    const { realpath } = await import('fs/promises')
    return (await realpath(cwd)).normalize('NFC')
  } catch {
    return cwd.normalize('NFC')
  }
}

async function transcriptHasTurns(path: string): Promise<boolean> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return false
  }
  try {
    const rl = createInterface({ input: fh.createReadStream() })
    for await (const line of rl) {
      if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
        rl.close()
        return true
      }
    }
    return false
  } catch {
    return false
  } finally {
    await fh.close().catch(() => {})
  }
}

function readExitCause(dir: string): string | undefined {
  const p = join(dir, 'exit-cause')
  try {
    const { readFileSync, unlinkSync } = require('fs') as typeof import('fs')
    const q = readFileSync(p, 'utf8')
    unlinkSync(p)
    return q
  } catch {
    return undefined
  }
}

/**
 * Official 2.1.153 `class KF`.
 */
export class BgWorker {
  dispatch: Dispatch
  spawnPty: SpawnPty | undefined
  getAuthSnapshot: (() => AuthSnapshot | undefined) | undefined
  via: string
  record: WorkerRecord
  onStream = createDaemonSignal<[string]>()
  onState = createDaemonSignal<[Partial<WorkerRecord>]>()
  onSettle = createDaemonSignal<[string]>()
  onRepaintDone = createDaemonSignal<[]>()
  attachers = new Map<string, { caps?: unknown }>()
  pty: PtyHandle | undefined
  procStart: string | undefined
  ptyCols = 200
  ptyRows = 50
  decModes = createDecModes()
  execTracker:
    | { feed: (s: string) => void; dispose: () => void; lastLine?: string }
    | undefined
  execLastLine: string | undefined
  offData: { dispose: () => void } | undefined
  offExit: { dispose: () => void } | undefined
  ring: string[] = []
  ringBytes = 0
  ringSpawnMark = 0
  attempt = 0
  lastSpawnAt = 0
  fastCrashStreak = 0
  lastExitCause: string | undefined
  backoffTimer: ReturnType<typeof setTimeout> | null = null
  pidPoll: ReturnType<typeof setInterval> | null = null
  rv: { send: (msg: unknown) => boolean; close: () => void } | undefined
  rvSockPath: string | undefined
  ptySockPath: string | undefined
  unverifiedSock: string | undefined
  phase: WorkerPhase = { kind: 'spawning' }
  workerReady = false
  resizeDeferred = false
  lastInputAt: number | undefined
  deleteJobDirOnSettle = false
  get shouldDeleteJobDir(): boolean {
    return this.deleteJobDirOnSettle
  }
  adoptedAt: number | undefined
  lastRvHeartbeat: number | undefined
  stalledLogged = false
  lastCheckPidAt = Date.now()
  replyChain: Promise<unknown> = Promise.resolve()
  killOutcome = 'killed'
  pidPollTick = 0

  get isKilling(): boolean {
    return this.phase.kind === 'retiring' && this.phase.reason === 'reap'
  }
  get isRetiring(): boolean {
    return this.phase.kind === 'retiring' && this.phase.reason === 'grace'
  }
  get isUnverified(): boolean {
    return this.unverifiedSock !== undefined
  }
  getPhase(): WorkerPhase {
    return this.phase
  }
  get isTransitioning(): boolean {
    return this.phase.kind !== 'running' || !this.pty || this.record.pid === 0
  }
  get isDetached(): boolean {
    return this.phase.kind === 'retiring' && this.phase.reason === 'stop'
  }

  transitionTo(next: WorkerPhase): boolean {
    if (!canTransition(this.phase, next)) {
      logForDebugging(
        `[bg] illegal worker-phase transition ${phaseName(this.phase)} → ${phaseName(next)} for ${this.record.short}`,
        { level: 'warn' },
      )
      bgEvent('tengu_bg_phase_illegal', {})
      return false
    }
    this.phase = next
    return true
  }

  constructor(
    dispatch: Dispatch,
    spawnPty: SpawnPty | undefined,
    getAuthSnapshot: (() => AuthSnapshot | undefined) | undefined,
    via: string,
    extra?: Partial<WorkerRecord>,
  ) {
    this.dispatch = dispatch
    this.spawnPty = spawnPty
    this.getAuthSnapshot = getAuthSnapshot
    this.via = via
    this.record = {
      short: dispatch.short,
      nonce: dispatch.nonce,
      sessionId: dispatch.sessionId,
      pid: 0,
      attempt: 0,
      startedAt: Date.now(),
      cwd: dispatch.cwd,
      backend: 'daemon',
      tempo: 'active',
      state: 'starting',
      detail: '',
      intent: dispatch.seed?.intent ?? '',
      name: dispatch.seed?.name,
      agent: dispatch.agent,
      routine: dispatch.routine,
      worktreePath: dispatch.worktree?.path,
      cliVersion: MACRO.VERSION,
      source: dispatch.source,
      ...extra,
    }
    if (dispatch.cols) this.ptyCols = dispatch.cols
    if (dispatch.rows) this.ptyRows = dispatch.rows
  }

  static spawn(
    dispatch: Dispatch,
    spawnPty: SpawnPty | undefined,
    getAuthSnapshot?: () => AuthSnapshot | undefined,
    opts?: { afterUpgrade?: boolean },
  ): BgWorker {
    const w = new BgWorker(
      dispatch,
      spawnPty ?? defaultSpawnPty(),
      getAuthSnapshot,
      'cold',
    )
    if (opts?.afterUpgrade) {
      w.attempt = 1
      void w.buildBridgeReattachEnvFromState().then(z => w.doSpawn(z))
      return w
    }
    void w.doSpawn(dispatch.reattachEnv)
    return w
  }

  static claim(
    dispatch: Dispatch,
    spare: {
      spawnPty: SpawnPty
      getAuthSnapshot?: () => AuthSnapshot | undefined
      pid: number
      ptySockPath: string
      startedAt: number
    },
  ): BgWorker {
    const q = new BgWorker(
      dispatch,
      spare.spawnPty,
      spare.getAuthSnapshot,
      'spare',
      {
        pid: spare.pid,
        attempt: 1,
        state: 'running',
        cliVersion: MACRO.VERSION,
      },
    )
    q.attempt = 1
    q.ptySockPath = spare.ptySockPath
    q.rvSockPath = rendezvousSock(dispatch.short)
    q.wirePty(connectPty(spare.ptySockPath, spare.pid, undefined, dispatch.short))
    q.resize(dispatch.cols ?? 200, dispatch.rows ?? 50)
    q.connectRv()
    void procStart(spare.pid, { skipCache: true }).then(K => {
      if (q.record.pid !== spare.pid || q.isDetached || q.record.outcome) return
      if (K) q.procStart = K
      q.patch({ pid: spare.pid })
    })
    return q
  }

  static async adopt(
    short: string,
    entry: RosterEntry,
    spawnPty: SpawnPty | undefined,
    getAuthSnapshot?: () => AuthSnapshot | undefined,
  ): Promise<BgWorker | null> {
    try {
      process.kill(entry.pid, 0)
    } catch (A) {
      const Y = getErrnoCode(A)
      if (Y === 'ESRCH' || Y === 'EPERM') return null
    }
    const start = await procStart(entry.pid)
    if (start && entry.procStart !== start) return null
    const z = new BgWorker(entry.dispatch, spawnPty, getAuthSnapshot, 'adopted', {
      pid: entry.pid,
      attempt: entry.attempt,
      startedAt: entry.startedAt,
      messagingSock: entry.messagingSock,
      state: 'adopted',
      detail: 'adopted from previous supervisor',
      cliVersion: entry.cliVersion,
      ...(!entry.ptySock ? { legacy: true } : {}),
    })
    z.attempt = entry.attempt
    z.procStart = entry.procStart
    z.workerReady = true
    z.adoptedAt = Date.now()
    z.rvSockPath = entry.rendezvousSock
    z.ptySockPath = entry.ptySock
    if (entry.ptySock) {
      z.wirePty(
        connectPty(entry.ptySock, entry.pid, z.procStart, z.dispatch.short),
      )
      z.ptyCols = 0
      z.seedFocus(false)
    }
    if (entry.decModes) z.decModes.seed(entry.decModes)
    z.connectRv()
    if (entry.pendingRespawn === 'upgrade') {
      z.transitionTo({ kind: 'upgrading' })
      setTimeout((A: BgWorker) => {
        if (A.phase.kind === 'upgrading' && !A.record.outcome) A.sigtermWorker()
      }, 5000, z).unref()
    }
    return z
  }

  static unverified(short: string, entry: RosterEntry): BgWorker {
    const q = new BgWorker(entry.dispatch, undefined, undefined, 'adopted', {
      pid: entry.pid,
      attempt: entry.attempt,
      startedAt: entry.startedAt,
      messagingSock: entry.messagingSock,
      state: 'adopted',
      detail: 'adopted (pid unverifiable; tracking via pty.sock)',
      cliVersion: entry.cliVersion,
    })
    q.attempt = entry.attempt
    q.procStart = entry.procStart
    q.rvSockPath = entry.rendezvousSock
    q.ptySockPath = entry.ptySock
    q.unverifiedSock = entry.ptySock
    q.lastInputAt = Date.now()
    q.pidPoll = setInterval((K: BgWorker) => {
      if (K.record.outcome || !K.unverifiedSock) return
      void import('net').then(({ connect }) => {
        const s = connect(K.unverifiedSock!)
        s.setTimeout(250, () => {
          s.destroy()
          if (!K.record.outcome && K.phase.kind === 'spawning') K.settle('crashed')
        })
        s.on('error', () => {
          if (!K.record.outcome && K.phase.kind === 'spawning') K.settle('crashed')
        })
        s.once('connect', () => s.destroy())
      })
    }, PID_POLL_MS, q)
    q.pidPoll.unref()
    bgEvent('tengu_bg_adopt_unverified', { short: asMeta(short) })
    return q
  }

  shutdownWorker(): boolean {
    const H = this.rv?.send({ type: 'shutdown' }) ?? false
    if (!H) this.sigtermWorker()
    else {
      setTimeout(($: BgWorker) => {
        const q = $.phase
        if (
          (q.kind === 'upgrading' ||
            (q.kind === 'retiring' && q.reason === 'grace')) &&
          !$.record.outcome
        ) {
          $.sigtermWorker()
        }
      }, 5000, this).unref()
    }
    return H
  }

  async respawnIfIdleStale(
    pinned?: Set<string>,
  ): Promise<{ respawned: boolean; reason: string }> {
    if (this.dispatch.launch.mode === 'exec') {
      return { respawned: false, reason: 'not-stale' }
    }
    if (this.isTransitioning) return { respawned: false, reason: 'in-progress' }
    if (this.record.outcome) return { respawned: false, reason: 'no-state' }
    if (this.attachers.size > 0) return { respawned: false, reason: 'attached' }
    const state = await readJobState(jobDir(this.dispatch.short))
    if (this.isTransitioning) return { respawned: false, reason: 'in-progress' }
    if (this.record.outcome) return { respawned: false, reason: 'no-state' }
    if (this.attachers.size > 0) return { respawned: false, reason: 'attached' }
    if (!state) return { respawned: false, reason: 'no-state' }
    if (isSettled(state) && !pinned?.has(this.dispatch.short)) {
      return { respawned: false, reason: 'settled' }
    }
    if (!state.cliVersion || state.cliVersion === MACRO.VERSION) {
      return { respawned: false, reason: 'not-stale' }
    }
    if (!isSettled(state) && state.tempo !== 'idle') {
      return { respawned: false, reason: 'busy' }
    }
    if (!this.transitionTo({ kind: 'upgrading' })) {
      return { respawned: false, reason: 'in-progress' }
    }
    this.onState.emit({ pid: this.record.pid })
    bgEvent('tengu_bg_respawn_stale', {
      short: asMeta(this.dispatch.short),
      rvSent: asMeta(this.shutdownWorker()),
    })
    return { respawned: true, reason: 'stale' }
  }

  async retireIfSettled(
    graceMs: number,
    pinned?: Set<string>,
    bridgedGrace = graceMs,
  ): Promise<{ retired: boolean; reason?: string }> {
    if (this.isTransitioning) return { retired: false, reason: 'in-progress' }
    if (this.record.outcome) return { retired: false, reason: 'no-state' }
    if (this.attachers.size > 0) return { retired: false, reason: 'attached' }
    if (pinned?.has(this.dispatch.short)) return { retired: false, reason: 'pinned' }
    if (this.adoptedAt && Date.now() - this.adoptedAt < RECENT_ADOPT_MS) {
      return { retired: false, reason: 'recent-adopt' }
    }
    if (this.lastInputAt && Date.now() - this.lastInputAt < graceMs) {
      return { retired: false, reason: 'recent-input' }
    }
    const K = await readJobState(jobDir(this.dispatch.short))
    if (this.isTransitioning || this.attachers.size > 0) {
      return { retired: false, reason: 'in-progress' }
    }
    if (this.lastInputAt && Date.now() - this.lastInputAt < graceMs) {
      return { retired: false, reason: 'recent-input' }
    }
    if (!K) {
      if (
        this.dispatch.source === 'spare' &&
        Date.now() - this.dispatch.createdAt > graceMs
      ) {
        if (!this.transitionTo({ kind: 'retiring', reason: 'grace' })) {
          return { retired: false, reason: 'in-progress' }
        }
        bgEvent('tengu_bg_retired', {
          short: asMeta(this.dispatch.short),
          rvSent: asMeta(this.shutdownWorker()),
          settledForMs: asMeta(Date.now() - this.dispatch.createdAt),
          state: asMeta('stale-spare'),
        })
        return { retired: true }
      }
      return { retired: false, reason: 'no-state' }
    }
    if (
      this.dispatch.source !== 'shell' &&
      !K.name &&
      !K.intent &&
      !K.worktreePath &&
      K.template === 'bg' &&
      K.state === 'working' &&
      K.tempo === 'blocked'
    ) {
      const A = Date.now() - Date.parse(K.createdAt)
      if (A < EMPTY_IDLE_MS) return { retired: false, reason: 'empty-idle-grace' }
      if (!this.transitionTo({ kind: 'retiring', reason: 'grace' })) {
        return { retired: false, reason: 'in-progress' }
      }
      this.deleteJobDirOnSettle = true
      bgEvent('tengu_bg_retired', {
        short: asMeta(this.dispatch.short),
        rvSent: asMeta(this.shutdownWorker()),
        settledForMs: asMeta(A),
        state: asMeta('empty-idle'),
      })
      return { retired: true }
    }
    if (!isSettled(K)) return { retired: false, reason: 'not-settled' }
    if ((K.inFlight?.tasks ?? 1) > 0 || (K.inFlight?.queued ?? 1) > 0) {
      return { retired: false, reason: 'inflight' }
    }
    if (K.inFlight?.kinds.includes('session_cron')) {
      return { retired: false, reason: 'session-cron' }
    }
    if (K.routine) return { retired: false, reason: 'routine' }
    const grace = K.bridgeSessionId ? Math.max(graceMs, bridgedGrace) : graceMs
    const z = K.updatedAt && Date.now() - Date.parse(K.updatedAt)
    if (!z || z < grace) return { retired: false, reason: 'grace' }
    if (!this.transitionTo({ kind: 'retiring', reason: 'grace' })) {
      return { retired: false, reason: 'in-progress' }
    }
    bgEvent('tengu_bg_retired', {
      short: asMeta(this.dispatch.short),
      rvSent: asMeta(this.shutdownWorker()),
      settledForMs: asMeta(z),
      bridged: asMeta(!!K.bridgeSessionId),
      state: asMeta(K.state),
    })
    return { retired: true }
  }

  sigtermWorker(): void {
    try {
      this.pty?.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }

  tail(n: number): string[] {
    return n > 0 ? this.ring.slice(-n) : []
  }
  ringSnapshot(): string[] {
    return this.ring
  }
  preInitErrorTail(): string | undefined {
    const H = Bun.stripANSI(this.ring.slice(this.ringSpawnMark).join(''))
      .replace(/\s+/g, ' ')
      .trim()
    if (!H) return
    return H.length > PREINIT_TAIL ? `…${H.slice(-PREINIT_TAIL)}` : H
  }
  decModeSnapshot(): number[] {
    return this.decModes.snapshot()
  }
  write(H: string): void {
    this.lastInputAt = Date.now()
    this.pty?.write(H)
  }
  noteActivity(): void {
    this.lastInputAt = Date.now()
  }
  shiftGraceClocksForward(H: number): void {
    if (H <= 0) return
    if (this.adoptedAt !== undefined) this.adoptedAt += H
    if (this.lastInputAt !== undefined) this.lastInputAt += H
  }
  seedFocus(H: boolean): void {
    if (this.dispatch.launch.mode === 'exec') return
    this.pty?.write(H ? FOCUS_IN : FOCUS_OUT)
  }
  resize(H: number, rows: number): void {
    this.ptyCols = H
    this.ptyRows = rows
    if (getPlatform() === 'windows' && !this.workerReady) {
      this.resizeDeferred = true
      return
    }
    try {
      this.pty?.resize(H, rows)
    } catch {
      /* ignore */
    }
  }
  signalPtyPgrp(): void {
    if (getPlatform() === 'windows' || !this.record.pid) return
    setTimeout((H: number) => {
      try {
        process.kill(-H, 'SIGWINCH')
      } catch {
        /* ignore */
      }
    }, 15, this.record.pid)
  }

  rosterEntry(): RosterEntry {
    return {
      pid: this.record.pid,
      procStart: this.procStart,
      sessionId: this.record.sessionId,
      rendezvousSock: this.rvSockPath ?? rendezvousSock(this.dispatch.short),
      ptySock: this.record.legacy
        ? undefined
        : this.ptySockPath ?? ptySockPathFor(this.dispatch.short),
      messagingSock: this.record.messagingSock,
      cliVersion: this.record.cliVersion,
      startedAt: this.record.startedAt,
      attempt: this.attempt,
      cwd: this.dispatch.cwd,
      worktreePath: this.dispatch.worktree?.path,
      dispatch: this.cappedDispatch(),
      pendingRespawn: this.phase.kind === 'upgrading' ? 'upgrade' : undefined,
      decModes: this.decModes.snapshot(),
    }
  }

  cappedDispatch(): Dispatch {
    return JSON.parse(
      JSON.stringify(this.dispatch, (H, $) =>
        H === 'reattachEnv' || H === 'attachStallRespawns'
          ? undefined
          : typeof $ === 'string' && $.length > CAPPED_STR
            ? $.slice(0, CAPPED_STR)
            : $,
      ),
    ) as Dispatch
  }

  kill(H = 'SIGTERM', outcome = 'killed', detail?: string): void {
    if (this.phase.kind === 'retired') return
    this.killOutcome = outcome
    if (detail) this.patch({ detail })
    this.transitionTo({ kind: 'retiring', reason: 'reap' })
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
    if (this.unverifiedSock) {
      void unlink(this.unverifiedSock).finally(() => this.settle(this.killOutcome))
      return
    }
    if (this.pty) {
      try {
        this.pty.kill(H)
      } catch {
        /* ignore */
      }
    } else if (this.record.pid && !this.pidRecycled()) {
      try {
        process.kill(-this.record.pid, H)
      } catch {
        try {
          process.kill(this.record.pid, H)
        } catch {
          /* ignore */
        }
      }
    }
    if (!this.pty) this.settle(this.killOutcome)
  }

  stop(): void {
    if (this.phase.kind === 'retiring' && this.phase.reason === 'reap') {
      this.settle(this.killOutcome)
    } else if (this.phase.kind === 'retiring' && this.phase.reason === 'grace') {
      this.settle('done')
    } else if (this.phase.kind !== 'retired') {
      this.transitionTo({ kind: 'retiring', reason: 'stop' })
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
    this.clearLiveness()
    this.offData?.dispose()
    this.offExit?.dispose()
    this.execTracker?.dispose()
    this.execTracker = undefined
    this.pty?.dispose()
    this.pty = undefined
  }

  async doSpawn(reattachEnv?: Record<string, string>): Promise<void> {
    this.attempt++
    this.workerReady = false
    this.resizeDeferred = false
    this.ringSpawnMark = this.ring.length
    this.lastSpawnAt = Date.now()
    const $ = this.dispatch
    const q = jobDir($.short)
    await mkdir(q, { recursive: true }).catch(() => {})
    const K =
      $.launch.mode === 'exec'
        ? undefined
        : await writeAuthSnapshot($.short, this.getAuthSnapshot?.())
    let _ = $.launch.mode === 'resume' ? $.launch.sessionId : undefined
    let z = false
    let A = false
    let Y = $.sessionId
    let O = $.respawnFlags
    if (this.attempt > 1) {
      const J = await readJobState(q)
      Y = J?.resumeSessionId ?? $.sessionId
      O = J?.respawnFlags ?? $.respawnFlags
      const X = await realpathNfc($.cwd)
      const L = join(getProjectDir(X), `${Y}.jsonl`)
      z = await transcriptHasTurns(L)
      A =
        !z &&
        _ !== undefined &&
        !(await transcriptHasTurns(join(getProjectDir(X), `${_}.jsonl`)))
      if (!z) await unlink(L).catch(() => {})
    }
    if (
      this.phase.kind === 'retiring' ||
      this.phase.kind === 'retired' ||
      this.record.outcome
    ) {
      return
    }
    if (A) {
      this.patch({ state: 'crashed', detail: `source session ${_} not found` })
      this.settle('crashed')
      return
    }
    if (!this.spawnPty) {
      this.patch({
        state: 'crashed',
        detail: 'Bun.Terminal unavailable (running under Node?)',
      })
      bgEvent('tengu_bg_pty_unavailable', { short: asMeta(this.dispatch.short) })
      this.settle('crashed')
      return
    }
    const f = workerArgv($, this.attempt, z, Y, O)
    const M = workerEnv($, q, K, this.rvSockPath ?? rendezvousSock($.short))
    if (this.attempt > 1 && z) M.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1'
    if (reattachEnv) Object.assign(M, reattachEnv)
    const j = this.ptyCols || ($.cols ?? 200)
    const w = this.ptyRows || ($.rows ?? 50)
    let D: PtyHandle
    try {
      const spec =
        $.launch.mode === 'exec'
          ? { cmd: $.launch.cmd, prefixArgs: [] as string[] }
          : getRelaunchSpec({ pinToCurrentBinary: true })
      D = this.spawnPty(spec.cmd, [...spec.prefixArgs, ...f], {
        cols: j,
        rows: w,
        cwd: $.cwd,
        env: M,
        ptySock: this.ptySockPath ?? ptySockPathFor($.short),
        short: $.short,
      })
    } catch (J) {
      if (isENOENT(J)) {
        const X = await access($.cwd)
          .then(() => true)
          .catch(() => false)
        if (this.record.outcome) return
        if (!X) return this.settleCwdGone('cold')
        const L =
          $.launch.mode === 'exec'
            ? `${$.launch.cmd}: command not found`
            : 'daemon binary was deleted (upgrade in progress) — run your command again to use the new version'
        bgEvent('tengu_bg_spawn_binary_gone', {
          short: asMeta(this.dispatch.short),
          attempt: asMeta(this.attempt),
        })
        this.patch({ state: 'crashed', detail: L })
        const P = `\r\n\x1B[2m[${L}]\x1B[0m\r\n`
        this.pushRing(P)
        this.onStream.emit(P)
        this.settle('crashed')
        return
      }
      this.scheduleRespawn(J instanceof Error ? J.message : String(J))
      return
    }
    if (getPlatform() === 'windows') {
      void writeFile(windowsPtyPidPath($.short), String(D.pid)).catch(() => {})
    }
    this.wirePty(D)
    this.rv?.close()
    this.rv = undefined
    this.lastRvHeartbeat = undefined
    this.stalledLogged = false
    this.connectRv()
    this.patch({
      pid: D.pid,
      attempt: this.attempt,
      state: this.attempt > 1 ? 'resuming' : 'running',
      detail: '',
      cliVersion: MACRO.VERSION,
    })
    bgEvent('tengu_bg_worker_spawn', {
      short: asMeta(this.dispatch.short),
      attempt: asMeta(this.attempt),
      source: asMeta(this.dispatch.source),
      launch_mode: asMeta(this.dispatch.launch.mode),
    })
    void procStart(D.pid, { skipCache: true }).then(J => {
      if (!J || this.record.pid !== D.pid || this.isDetached || this.record.outcome)
        return
      this.procStart = J
      this.patch({ pid: D.pid })
    })
  }

  wirePty(H: PtyHandle): void {
    this.pty = H
    this.transitionTo({ kind: 'running' })
    this.decModes = createDecModes()
    H.onResume?.(() => {
      this.rv?.send({ type: 'repaint' })
    })
    this.offData = H.onData(q => {
      if (this.decModes.feed(q) && this.record.pid) {
        this.onState.emit({ pid: this.record.pid })
      }
      this.execTracker?.feed(q)
      this.pushRing(q.includes(DETACH_OSC) ? q.replaceAll(DETACH_OSC, '') : q)
      this.onStream.emit(q)
    })
    let once = false
    this.offExit = H.onExit(({ exitCode: q, signal: K }) => {
      if (once) return
      once = true
      this.offData?.dispose()
      this.execLastLine = this.execTracker?.lastLine
      this.execTracker?.dispose()
      this.execTracker = undefined
      this.pty = undefined
      this.onExit(q, K)
    })
  }

  pushRing(H: string): void {
    this.ring.push(H)
    this.ringBytes += H.length
    if (this.ringBytes > RING_CAP * 1.25 && this.ring.length > 1) {
      let $ = 0
      let q = 0
      while (this.ringBytes - q > RING_CAP && $ < this.ring.length - 1) {
        q += this.ring[$]!.length
        $++
      }
      this.ring.splice(0, $)
      this.ringBytes -= q
      this.ringSpawnMark = Math.max(0, this.ringSpawnMark - $)
    }
  }

  patch(H: Partial<WorkerRecord>): void {
    Object.assign(this.record, H)
    this.onState.emit(H)
  }

  onExit(H: number, $?: string): void {
    if (this.isDetached) return
    if (this.phase.kind === 'retired') return
    const q = this.lastSpawnAt ? Date.now() - this.lastSpawnAt : undefined
    const K = q !== undefined && q < FAST_CRASH_MS && H !== 0
    if (K) this.fastCrashStreak++
    else this.fastCrashStreak = 0
    const _ = this.fastCrashStreak >= 3
    const z = this.workerReady ? undefined : this.preInitErrorTail()
    const A = H !== 0 ? readExitCause(jobDir(this.dispatch.short)) : undefined
    const Y = K && !!A && A === this.lastExitCause
    this.lastExitCause = K ? A : undefined
    const O = z ? ` — ${z}` : A ? ` — ${A}` : ''
    const f =
      this.dispatch.launch.mode === 'exec' &&
      ($ === 'SIGINT' || $ === 'SIGQUIT')
    let M: string | undefined
    if (this.phase.kind === 'retiring' && this.phase.reason === 'reap') {
      M = this.killOutcome
    } else if (this.phase.kind === 'retiring' && this.phase.reason === 'grace') {
      M = 'done'
    } else if (this.phase.kind === 'upgrading') M = undefined
    else if (H === 0) M = 'done'
    else if (this.dispatch.launch.mode === 'exec') M = f ? 'killed' : 'crashed'
    else if (
      (!this.workerReady && (this.attempt >= 2 || z)) ||
      _ ||
      Y ||
      this.attempt >= MAX_ATTEMPTS
    ) {
      M = 'crashed'
    }
    bgEvent('tengu_bg_worker_exit', {
      short: asMeta(this.dispatch.short),
      code: H as unknown as ReturnType<typeof asMeta>,
      signal: asMeta($ ?? ''),
      attempt: asMeta(this.attempt),
      procUptimeMs: asMeta(q ?? 0),
      source: asMeta(this.dispatch.source),
      launch_mode: asMeta(this.dispatch.launch.mode),
      outcome: asMeta(M ?? ''),
      exitCause: asMeta(A ?? ''),
    })
    if (this.phase.kind === 'retiring') {
      this.settle(this.phase.reason === 'reap' ? this.killOutcome : 'done')
      return
    }
    if (this.phase.kind === 'upgrading') {
      this.transitionTo({ kind: 'spawning' })
      this.attempt = 1
      this.fastCrashStreak = 0
      this.lastExitCause = undefined
      this.patch({ pid: 0, state: 'starting', detail: 'upgrading' })
      this.procStart = undefined
      void this.buildBridgeReattachEnvFromState().then(w => this.doSpawn(w))
      return
    }
    if (H === 0) {
      if (this.dispatch.launch.mode === 'exec') {
        this.patch({ detail: this.execLastLine || '(no output)' })
      }
      this.settle('done')
      return
    }
    const j = $ ? `${$} (${H})` : `exit ${H}`
    if (this.dispatch.launch.mode === 'exec') {
      const w = this.execLastLine
      this.patch({
        state: f ? 'stopped' : 'crashed',
        detail: w ? `${j} — ${w}` : `${j}${O}`,
      })
      this.settle(f ? 'killed' : 'crashed')
      return
    }
    if (!this.workerReady && A === 'spare_postclaim:ENOENT') {
      try {
        accessSync(this.dispatch.cwd)
      } catch {
        this.settleCwdGone('spare')
        return
      }
    }
    if (!this.workerReady && (this.attempt >= 2 || z)) {
      this.patch({ state: 'crashed', detail: `${j} before init${O}` })
      this.settle('crashed')
      return
    }
    if (_ || Y) {
      this.patch({
        state: 'crashed',
        detail: Y
          ? `${j} ×${this.attempt}${O}`
          : `${j} within ${FAST_CRASH_MS / 1000}s of spawn ×${this.fastCrashStreak}${O}`,
      })
      this.settle('crashed')
      return
    }
    this.scheduleRespawn(`${j}${O}`)
  }

  /** Official 2.1.153 `settleCwdGone`. */
  settleCwdGone(via: string): void {
    const $ = `working directory no longer exists: ${this.dispatch.cwd}`
    bgEvent('tengu_bg_spawn_cwd_gone', {
      short: asMeta(this.dispatch.short),
      attempt: asMeta(this.attempt),
      via: asMeta(via),
    })
    this.patch({ state: 'crashed', detail: $ })
    const q = `\r\n\x1B[2m[${$} — this job cannot be respawned]\x1B[0m\r\n`
    this.pushRing(q)
    this.onStream.emit(q)
    this.settle('crashed')
  }

  async buildBridgeReattachEnvFromState(): Promise<
    Record<string, string> | undefined
  > {
    const H = await readJobState(jobDir(this.dispatch.short)).catch(() => null)
    if (!H) return
    return bridgeReattachEnv(
      H.bridgeSessionId,
      H.bridgeSessionSeq,
      H.bridgeOutboundOnly,
    )
  }

  scheduleRespawn(H: string): void {
    if (this.attempt >= MAX_ATTEMPTS) {
      bgEvent('tengu_bg_respawn_exhausted', {
        short: asMeta(this.dispatch.short),
        attempts: asMeta(this.attempt),
      })
      this.patch({ state: 'crashed', detail: H })
      this.settle('crashed')
      return
    }
    if (this.phase.kind === 'running') this.transitionTo({ kind: 'spawning' })
    this.patch({ pid: 0, state: 'crashed', detail: `${H}; respawning` })
    this.procStart = undefined
    const $ = `\r\n\x1B[2m[worker crashed (${H}) — respawning…]\x1B[0m\r\n`
    this.pushRing($)
    this.onStream.emit($)
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      if (this.phase.kind !== 'retiring' && this.phase.kind !== 'retired') {
        void this.doSpawn()
      }
    }, BACKOFF_MS)
    this.backoffTimer.unref()
  }

  settle(H: string): void {
    if (this.record.outcome) return
    bgEvent('tengu_bg_settle', {
      short: asMeta(this.dispatch.short),
      outcome: asMeta(H),
      uptimeMs: asMeta(Date.now() - this.record.startedAt),
      attempt: asMeta(this.attempt),
    })
    this.transitionTo({ kind: 'retired', outcome: H })
    this.clearLiveness()
    this.patch({ outcome: H, settledAt: Date.now(), tempo: 'idle' })
    this.onSettle.emit(H)
  }

  connectRv(): void {
    if (this.rv || this.isDetached || this.record.outcome) return
    if (this.dispatch.launch.mode === 'exec') {
      this.startPidPoll()
      return
    }
    this.rv = connectRendezvous(
      this.rvSockPath ?? rendezvousSock(this.dispatch.short),
      H => {
        if (H.type === 'heartbeat') this.lastRvHeartbeat = Date.now()
        else if (H.type === 'done') this.settle(String(H.outcome ?? 'done'))
        else if (H.type === 'state') this.patch(H.patch as Partial<WorkerRecord>)
        else if (H.type === 'detach-request') {
          this.onStream.emit(detachOsc(H.msg as string | undefined))
        } else if (H.type === 'repaint-done') this.onRepaintDone.emit()
      },
      () => void this.checkPid(),
      () => {
        this.workerReady = true
        if (this.resizeDeferred) {
          this.resizeDeferred = false
          this.resize(this.ptyCols, this.ptyRows)
        }
        if (this.attachers.size > 0) {
          const H = [...this.attachers.values()].at(-1)
          this.rv?.send({ type: 'attacher-caps', caps: H?.caps ?? null })
        } else this.rv?.send({ type: 'attacher-caps', caps: null })
      },
    )
    this.startPidPoll()
  }

  startPidPoll(): void {
    if (this.pidPoll) return
    this.lastCheckPidAt = Date.now()
    this.pidPoll = setInterval(() => void this.checkPid(true), PID_POLL_MS)
    this.pidPoll.unref()
  }

  pidRecycled(): boolean {
    if (!this.procStart || !this.record.pid) return false
    const H = procStartSync(this.record.pid)
    return H !== undefined && H !== this.procStart
  }

  async checkPid(fromPoll = false): Promise<void> {
    if (this.record.outcome || !this.record.pid) return
    const $ = Date.now() - this.lastCheckPidAt
    this.lastCheckPidAt = Date.now()
    const q = $ > PID_POLL_MS * 3
    if (q && this.lastRvHeartbeat !== undefined) {
      this.lastRvHeartbeat = Date.now()
    }
    if (!this.pty) {
      try {
        process.kill(this.record.pid, 0)
      } catch (_) {
        const z = getErrnoCode(_)
        if (z === 'ESRCH' || z === 'EPERM') {
          this.logVanished(false, fromPoll)
          this.settle(this.isKilling ? 'killed' : 'crashed')
        }
        return
      }
    }
    const K = this.lastRvHeartbeat
    if (!q && !this.stalledLogged && K !== undefined && Date.now() - K > STALL_MS) {
      const job = await readJobState(jobDir(this.dispatch.short))
      if (
        !this.stalledLogged &&
        (job?.tempo ?? this.record.tempo) === 'active'
      ) {
        this.stalledLogged = true
        bgEvent('tengu_bg_worker_stalled', {
          short: asMeta(this.dispatch.short),
          sinceMs: asMeta(Date.now() - K),
        })
      }
    }
    if (this.pty) return
    if (fromPoll && this.pidPollTick++ % 12 !== 0) return
    const recycled = await procStart(this.record.pid)
    if (
      recycled !== undefined &&
      this.procStart !== undefined &&
      recycled !== this.procStart
    ) {
      if (this.record.outcome || this.pty) return
      this.logVanished(true, fromPoll)
      this.settle(this.isKilling ? 'killed' : 'crashed')
    }
  }

  logVanished(recycled: boolean, fromPoll: boolean): void {
    if (this.isKilling) return
    bgEvent('tengu_bg_worker_vanished', {
      short: asMeta(this.dispatch.short),
      recycled: asMeta(recycled),
      fromPoll: asMeta(fromPoll),
      uptimeMs: asMeta(Date.now() - this.record.startedAt),
    })
  }

  clearLiveness(): void {
    if (this.pidPoll) {
      clearInterval(this.pidPoll)
      this.pidPoll = null
    }
    this.rv?.close()
    this.rv = undefined
    this.lastRvHeartbeat = undefined
    this.stalledLogged = false
  }
}

/** Alias matching official `KF`. */
export { BgWorker as KF }
