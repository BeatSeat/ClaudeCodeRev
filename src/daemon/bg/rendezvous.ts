import { Socket } from 'net'
import { logForDebugging } from '../../utils/debug.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { readJobState, writeJobState } from './jobState.js'
import { DAEMON_PROTO, type JobState } from './types.js'
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

/** Official 2.1.178 `Sp8`. */
export const STARTUP_DIALOG_DETAIL = 'stuck on a startup dialog'
/** Official 2.1.178 `Pm$`. */
export const STARTUP_DIALOG_NEEDS = 'open this session to continue setup'
/** Official 2.1.178 `bp`. */
export const SEND_PROMPT_NEEDS = 'send a prompt to start'

let startupDialogLatch = false

export type StartupDialogPrior = {
  tempo: JobState['tempo']
  needs: JobState['needs']
  detail: JobState['detail']
}

/**
 * Official 2.1.178 `pSf` / `markStartupDialogBlocked`.
 * Listen-server `VU` state patch is a pre-existing CSf gap — persist only.
 */
export async function markStartupDialogBlocked(
  reason?: string,
): Promise<StartupDialogPrior | undefined> {
  const dir = process.env.CLAUDE_JOB_DIR
  if (!dir || startupDialogLatch) return
  const cur = await readJobState(dir)
  if (!cur || (cur.tempo === 'blocked' && cur.needs !== SEND_PROMPT_NEEDS)) {
    return
  }
  const detail = reason
    ? `${STARTUP_DIALOG_DETAIL} (${reason})`
    : STARTUP_DIALOG_DETAIL
  await writeJobState(dir, {
    ...cur,
    tempo: 'blocked',
    detail,
    needs: STARTUP_DIALOG_NEEDS,
    updatedAt: new Date().toISOString(),
  })
  return { tempo: cur.tempo, needs: cur.needs, detail: cur.detail }
}

/** Official 2.1.178 `BSf` / `clearStartupDialogBlocked`. */
export async function clearStartupDialogBlocked(
  prior: StartupDialogPrior,
): Promise<void> {
  const dir = process.env.CLAUDE_JOB_DIR
  if (!dir) return
  const cur = await readJobState(dir)
  if (
    !cur ||
    cur.tempo !== 'blocked' ||
    cur.needs !== STARTUP_DIALOG_NEEDS
  ) {
    return
  }
  await writeJobState(dir, {
    ...cur,
    ...prior,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * Official 2.1.178 `Gh`. Mark the bg job blocked for a startup dialog, then
 * restore the prior tempo when the dialog promise settles.
 */
export async function wrapStartupDialogBlocked<T>(
  work: Promise<T>,
): Promise<T> {
  if (!process.env.CLAUDE_JOB_DIR) return work
  const marked = markStartupDialogBlocked().catch(() => undefined)
  return work.finally(() =>
    marked
      .then(prior =>
        prior ? clearStartupDialogBlocked(prior) : undefined,
      )
      .catch(() => {}),
  )
}
