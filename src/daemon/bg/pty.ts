import { readFile, unlink } from 'fs/promises'
import { Socket } from 'net'
import { StringDecoder } from 'string_decoder'
import { getRelaunchSpec } from '../../utils/relaunch.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { createDaemonSignal } from './events.js'
import { sockErrPath } from './paths.js'
import {
  killProcessGroup,
  pidStartMatches,
  procStart,
  procStartSync,
} from './procStart.js'
import { asMeta, bgEvent } from './telemetry.js'
import type { PtyHandle, SpawnPty } from './types.js'

const KIND_DATA = 0
const KIND_CTRL = 1
const HEADER = 5
const MAX_FRAME = 1048576
const CONNECT_BACKOFF = [50, 100, 250, 500, 1000, 2000]
const MAX_CONNECT = 30
const HUNG_AFTER = 4
const DRAIN_MS = 10000
const WRITABLE_STALL_MS = 30000
const HIGH_WATER = 8 * MAX_FRAME

function dataFrame(payload: Buffer): Buffer {
  const q = Buffer.allocUnsafe(HEADER + payload.length)
  q.writeUInt32BE(payload.length, 0)
  q.writeUInt8(KIND_DATA, 4)
  payload.copy(q, HEADER)
  return q
}

function ctrlFrame(ctrl: Record<string, unknown>): Buffer {
  const payload = Buffer.from(jsonStringify(ctrl), 'utf8')
  const q = Buffer.allocUnsafe(HEADER + payload.length)
  q.writeUInt32BE(payload.length, 0)
  q.writeUInt8(KIND_CTRL, 4)
  payload.copy(q, HEADER)
  return q
}

type Frame =
  | { kind: typeof KIND_DATA; payload: Buffer }
  | { kind: typeof KIND_CTRL; ctrl: { t?: string; [k: string]: unknown } }

/** Official `tT8`. */
function frameParser(
  onFrame: (frame: Frame) => void,
  onError: (msg: string) => void,
): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0)
  let dead = false
  return chunk => {
    if (dead) return
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk])
    while (buf.length >= HEADER) {
      const z = buf.readUInt32BE(0)
      if (z > MAX_FRAME) {
        dead = true
        onError(`frame too large (${z} > ${MAX_FRAME})`)
        return
      }
      const A = HEADER + z
      if (buf.length < A) return
      const Y = buf.readUInt8(4)
      const O = buf.subarray(HEADER, A)
      buf = buf.subarray(A)
      if (Y === KIND_DATA) onFrame({ kind: KIND_DATA, payload: Buffer.from(O) })
      else if (Y === KIND_CTRL) {
        let f: unknown
        try {
          f = JSON.parse(O.toString('utf8'))
        } catch {
          dead = true
          onError('bad ctrl json')
          return
        }
        onFrame({
          kind: KIND_CTRL,
          ctrl: f as { t?: string; [k: string]: unknown },
        })
      } else {
        dead = true
        onError(`unknown frame kind ${Y}`)
        return
      }
    }
  }
}

/**
 * Official 2.1.153 `yh8`. Connects to a `--bg-pty-host` socket and exposes
 * write/resize/kill/onData/onExit.
 */
export function connectPty(
  sockPath: string,
  pid: number,
  procStartAt: string | undefined,
  short: string | undefined,
  child?: { exited: Promise<number>; signalCode?: string | null },
): PtyHandle {
  const onDataSig = createDaemonSignal<[string]>()
  const onExitSig = createDaemonSignal<[{ exitCode: number; signal?: string }]>()
  let onResumeCb: (() => void) | undefined
  const decoder = new StringDecoder('utf8')
  let sock: Socket | undefined
  let disposed = false
  let exited = false
  let attempts = 0
  let hungLeft = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let winKillTimer: ReturnType<typeof setTimeout> | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let replPid = 0
  let replVersion: string | undefined
  let sawHello = false
  let liveAfterHello = false
  let lastConnectEnoent = false
  let start = procStartAt
  if (start === undefined) {
    void procStart(pid, { skipCache: true }).then(v => {
      start = v
    })
  }
  const pending: Buffer[] = []
  let pendingBytes = 0

  function send(frame: Buffer): boolean {
    if (sock) {
      if (sock.destroyed) return false
      if (!sock.write(frame)) {
        if (!drainTimer) {
          drainTimer = setTimeout(() => {
            drainTimer = undefined
            sock?.destroy()
          }, DRAIN_MS)
          drainTimer.unref()
        }
        if (!stallTimer && sock.writableLength > HIGH_WATER) {
          stallTimer = setTimeout(() => {
            stallTimer = undefined
            if (sock && !sock.destroyed && sock.writableLength > HIGH_WATER) {
              clearTimers()
              sock.destroy()
            }
          }, WRITABLE_STALL_MS)
          stallTimer.unref()
        }
      }
      return true
    }
    if (pendingBytes < 2 * MAX_FRAME) {
      pending.push(frame)
      pendingBytes += frame.length
    }
    return false
  }

  function clearTimers(): void {
    if (drainTimer) {
      clearTimeout(drainTimer)
      drainTimer = undefined
    }
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = undefined
    }
  }

  function finish(exitCode: number, signal?: string): void {
    if (exited) return
    exited = true
    disposed = true
    if (winKillTimer) {
      clearTimeout(winKillTimer)
      winKillTimer = undefined
    }
    clearTimers()
    sock?.destroy()
    sock = undefined
    const tail = decoder.end()
    if (tail) onDataSig.emit(tail)
    onExitSig.emit({ exitCode, signal })
  }

  function hostDead(via: string): void {
    void readFile(sockErrPath(sockPath), 'utf8')
      .then(g => {
        logForDebugging(`[bg-pty] host crash: ${g.trim()}`, { level: 'warn' })
        return true
      })
      .catch(() => false)
      .then(g =>
        bgEvent('tengu_bg_ptyhost_crash', {
          hadBreadcrumb: asMeta(g),
          hadHello: asMeta(sawHello),
          via: asMeta(via),
          short: asMeta(short ?? ''),
        }),
      )
    killProcessGroup(replPid ? [-pid, replPid] : [-pid], via !== 'hung' ? undefined : start)
    if (child) {
      void child.exited.then(
        g => finish(g, child.signalCode ?? undefined),
        () => finish(-1),
      )
      setTimeout(finish, 1000, -1).unref()
      return
    }
    finish(-1)
  }

  function onFrame(frame: Frame): void {
    if (frame.kind === KIND_DATA) {
      if (!liveAfterHello) onDataSig.emit(decoder.write(frame.payload))
    } else if (frame.ctrl.t === 'hello') {
      if (sawHello) {
        liveAfterHello = true
        decoder.end()
      }
      sawHello = true
      replPid = Number(frame.ctrl.replPid) || 0
      replVersion = frame.ctrl.version as string | undefined
    } else if (frame.ctrl.t === 'live') {
      if (liveAfterHello) {
        liveAfterHello = false
        onResumeCb?.()
      }
    } else if (frame.ctrl.t === 'exit') {
      finish(Number(frame.ctrl.code) || 0, frame.ctrl.signal as string | undefined)
    }
  }

  function connect(): void {
    if (disposed) return
    const Q = new Socket()
    let connected = false
    Q.on('error', l => {
      lastConnectEnoent = getErrnoCode(l) === 'ENOENT'
      scheduleReconnect()
    })
    Q.once('close', () => {
      if (sock === Q) {
        sock = undefined
        clearTimers()
      }
      if (disposed) return
      if (connected && !exited) {
        try {
          process.kill(pid, 0)
          logForDebugging('[bg-pty] dropped by host; reconnecting', {
            level: 'debug',
          })
          hungLeft = HUNG_AFTER
          attempts = 0
          scheduleReconnect()
          return
        } catch {
          /* process gone */
        }
        hostDead('close')
        return
      }
      scheduleReconnect()
    })
    Q.once('connect', () => {
      connected = true
      attempts = 0
      hungLeft = 0
      sock = Q
      Q.on('drain', clearTimers)
      void unlink(sockErrPath(sockPath)).catch(() => {})
      for (const d of pending.splice(0)) send(d)
      pendingBytes = 0
      const parse = frameParser(onFrame, d => {
        logForDebugging(`[bg-pty] frame error: ${d}`, { level: 'warn' })
        Q.destroy()
      })
      Q.on('data', parse)
    })
    Q.connect(sockPath)
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return
    try {
      process.kill(pid, 0)
    } catch {
      hostDead('connect')
      return
    }
    if (hungLeft > 0 && --hungLeft === 0) {
      hostDead('hung')
      return
    }
    if (procStartAt !== undefined && lastConnectEnoent && attempts >= 3) {
      logForDebugging(
        `[bg-pty] ${sockPath}: ENOENT on adopt — sock file externally deleted; respawning`,
        { level: 'warn' },
      )
      bgEvent('tengu_bg_adopt_sock_unlinked', {})
      attempts = MAX_CONNECT
    }
    if (attempts >= MAX_CONNECT) {
      logForDebugging(
        `[bg-pty] ${sockPath}: ${attempts} connect attempts failed; treating host as dead`,
        { level: 'warn' },
      )
      const g = start && procStartSync(pid)
      if (!start || !g || start === g) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }
      finish(-1)
      return
    }
    const delay = CONNECT_BACKOFF[Math.min(attempts, CONNECT_BACKOFF.length - 1)]!
    attempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
    reconnectTimer.unref()
  }

  connect()
  return {
    pid,
    replPid: () => replPid,
    replVersion: () => replVersion,
    onResume: Q => {
      onResumeCb = Q
    },
    write: Q => {
      if (exited) return
      const g = Buffer.from(Q, 'utf8')
      const l = MAX_FRAME - 1
      for (let d = 0; d < g.length; d += l) send(dataFrame(g.subarray(d, d + l)))
    },
    resize: (Q, g) => send(ctrlFrame({ t: 'resize', cols: Q, rows: g })),
    kill: Q => {
      const g = Q === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
      const l = send(ctrlFrame({ t: 'kill', sig: g }))
      if (getPlatform() === 'windows' && g === 'SIGTERM' && l) {
        if (winKillTimer) clearTimeout(winKillTimer)
        winKillTimer = setTimeout(
          (d: number, r: (code: number) => void) => {
            if (!pidStartMatches(d, start)) {
              r(-1)
              return
            }
            try {
              process.kill(d, 'SIGKILL')
            } catch {
              r(-1)
            }
          },
          5000,
          pid,
          finish,
        )
        winKillTimer.unref()
        return
      }
      try {
        process.kill(-pid, g)
      } catch {
        try {
          process.kill(pid, g)
        } catch {
          finish(-1)
        }
      }
      if (g === 'SIGTERM' && !exited) {
        if (winKillTimer) clearTimeout(winKillTimer)
        winKillTimer = setTimeout(
          (d: number, r: (code: number, sig?: string) => void) => {
            if (!pidStartMatches(d, start)) {
              r(-1)
              return
            }
            try {
              process.kill(-d, 'SIGKILL')
            } catch {
              try {
                process.kill(d, 'SIGKILL')
              } catch {
                r(-1)
              }
            }
          },
          5000,
          pid,
          finish,
        )
        winKillTimer.unref()
      }
    },
    dispose: () => {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      if (winKillTimer) {
        clearTimeout(winKillTimer)
        winKillTimer = undefined
      }
      clearTimers()
      sock?.destroy()
      sock = undefined
    },
    onData: Q => ({ dispose: onDataSig.subscribe(Q) }),
    onExit: Q => ({ dispose: onExitSig.subscribe(Q) }),
  }
}

/** Official `iqq`. Default `spawnPty`: `Bun.spawn --bg-pty-host`. */
export function defaultSpawnPty(): SpawnPty {
  return (cmd, args, q) => {
    const { cmd: K, prefixArgs } = getRelaunchSpec({ pinToCurrentBinary: true })
    const z = Bun.spawn(
      [K, ...prefixArgs, '--bg-pty-host', q.ptySock, String(q.cols), String(q.rows), '--', cmd, ...args],
      {
        cwd: q.cwd,
        env: q.env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      },
    )
    z.unref()
    return connectPty(q.ptySock, z.pid, undefined, q.short, z)
  }
}
