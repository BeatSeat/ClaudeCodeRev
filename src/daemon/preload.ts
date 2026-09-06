import { mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { timingSafeEqual } from 'crypto'
import { createServer } from 'net'
import { dirname } from 'path'
import { errorMessage } from '../utils/errors.js'
import { jsonParse } from '../utils/slowOperations.js'

/** Official 2.1.178 `aq1`. */
export const PRELOAD_CLAIM_SOCK = '/home/claude/.claude/remote/spare.sock'

/** Official 2.1.178 `rCz`. */
const PRELOAD_WIPE_ENV = [
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WORKER_EPOCH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_BASE_REF',
  'CLAUDE_CODE_BASE_REFS',
  'CLAUDE_CODE_REPO_CHECKOUTS',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
] as const

/** Official 2.1.178 `U$H` (auth compare used by `Ki8`). */
function timingSafeAuthEqual(got: unknown, expected: string): boolean {
  if (typeof got !== 'string' || !expected || got.length === 0) return false
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Official 2.1.178 `Ki8`. Unix listen; one JSON line; optional auth `q`.
 */
export function listenPreloadClaim(
  sockPath: string,
  onListening?: () => void,
  auth?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      server.close()
      reject(err)
    }
    const server = createServer(socket => {
      let buf = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buf += chunk
        if (auth && buf.length > 8_388_608) {
          socket.destroy()
          return
        }
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        if (auth) {
          let parsed: { auth?: unknown } | undefined
          try {
            parsed = jsonParse(buf.slice(0, nl)) as { auth?: unknown }
          } catch {
            parsed = undefined
          }
          if (!parsed || !timingSafeAuthEqual(parsed.auth, auth)) {
            socket.destroy()
            return
          }
          server.close()
          resolve(parsed)
          return
        }
        server.close()
        try {
          resolve(jsonParse(buf.slice(0, nl)))
        } catch (err) {
          reject(err)
        }
      })
      socket.on('error', auth ? () => socket.destroy() : fail)
    })
    server.on('error', fail)
    if (onListening) {
      server.once('listening', () => {
        try {
          onListening()
        } catch (err) {
          fail(err)
        }
      })
    }
    server.listen(sockPath)
  })
}

/**
 * Official 2.1.178 `oCz`. Claim a spare worker over `aq1`. Session takeover
 * `_i8` lives in the CLI entry (out of this lock) — export the claim so
 * `--preload` can wire it.
 */
export async function runPreload(argv: string[]): Promise<unknown> {
  const sock = argv[0] || PRELOAD_CLAIM_SOCK
  const pidPath = `${sock}.pid`
  for (const key of PRELOAD_WIPE_ENV) {
    delete process.env[key]
  }
  try {
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 })
    unlinkSync(sock)
  } catch {
    // sock may already be gone
  }
  const cleanup = (): void => {
    for (const p of [sock, pidPath]) {
      try {
        unlinkSync(p)
      } catch {
        // best-effort
      }
    }
  }
  const onSignal = (): void => {
    cleanup()
    process.exit(0)
  }
  const onUncaught = (err: unknown): void => {
    cleanup()
    process.stderr.write(`[preload] uncaughtException: ${errorMessage(err)}\n`)
    process.exit(1)
  }
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(sig, onSignal)
  }
  process.on('uncaughtException', onUncaught)
  let claim: unknown
  try {
    claim = await listenPreloadClaim(sock, () => {
      writeFileSync(pidPath, String(process.pid), { mode: 0o600 })
    })
  } catch (err) {
    cleanup()
    process.stderr.write(`[preload] claim recv failed: ${errorMessage(err)}\n`)
    process.exit(1)
  }
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.off(sig, onSignal)
  }
  process.off('uncaughtException', onUncaught)
  cleanup()
  return claim
}
