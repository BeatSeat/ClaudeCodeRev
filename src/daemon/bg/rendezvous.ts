import { Socket } from 'net'
import { logForDebugging } from '../../utils/debug.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DAEMON_PROTO } from './types.js'
import { asMeta, bgEvent } from './telemetry.js'

const BACKOFF = [100, 250, 500, 1000, 2000]
const MAX_ATTEMPTS = 30

type RvMsg = { type: string; [k: string]: unknown }

/** Official `p89`. */
export function connectRendezvous(
  sockPath: string,
  onMsg: (msg: RvMsg) => void,
  onClose: () => void,
  onReady?: () => void,
): { send: (msg: unknown) => boolean; close: () => void } {
  let sock: Socket | undefined
  let closed = false
  let attempts = 0
  let gaveUp = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function connect(): void {
    if (closed) return
    const j = new Socket()
    let connected = false
    j.on('error', () => schedule())
    j.once('close', () => {
      if (sock === j) sock = undefined
      if (closed) return
      if (connected) onClose()
      schedule()
    })
    j.once('connect', () => {
      connected = true
      attempts = 0
      gaveUp = false
      sock = j
      onReady?.()
      j.write(
        jsonStringify({
          proto: DAEMON_PROTO,
          role: 'supervisor',
          supervisorPid: process.pid,
        }) + '\n',
      )
      let buf = ''
      j.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            onMsg(parsed as RvMsg)
          }
        }
      })
    })
    j.connect(sockPath)
  }

  function schedule(): void {
    if (closed || timer || gaveUp) return
    if (attempts >= MAX_ATTEMPTS) {
      gaveUp = true
      logForDebugging(
        `[bg-rv] ${sockPath}: ${attempts} connect attempts failed — giving up (pid-poll is liveness backstop)`,
        { level: 'warn' },
      )
      bgEvent('tengu_bg_rv_connect_exhausted', { attempts: asMeta(attempts) })
      return
    }
    const delay = BACKOFF[Math.min(attempts, BACKOFF.length - 1)]!
    attempts++
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
    timer.unref()
  }

  connect()
  return {
    send(msg) {
      if (!sock || sock.destroyed) {
        if (attempts >= MAX_ATTEMPTS) {
          attempts = 0
          gaveUp = false
          schedule()
        }
        return false
      }
      try {
        return sock.write(jsonStringify(msg) + '\n'), true
      } catch (w) {
        logForDebugging(`[bg-rv] send failed: ${String(w)}`)
        return false
      }
    },
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      sock?.destroy()
      sock = undefined
    },
  }
}

/** Official `jqH`. */
export function detachOsc(msg?: string): string {
  const DETACH = '\x1B_cc-daemon-detach\x1B\\'
  if (!msg) return DETACH
  return `\x1B_cc-detach-msg;${msg}\x1B\\${DETACH}`
}
