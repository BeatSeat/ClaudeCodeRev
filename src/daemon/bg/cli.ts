import { logError } from '../../utils/log.js'
import {
  defaultDaemonJsonPath,
  defaultDaemonLogPath,
  isBackgroundAgentsDisabled,
  runDaemonSupervisor,
} from './run.js'
import { featureBad } from './telemetry.js'
import type { DaemonOrigin } from './types.js'

function parseOrigin(H: string): DaemonOrigin | undefined {
  if (H === 'service' || H === 'transient' || H === 'foreground') return H
  return undefined
}

/** Official `e09`. */
export function parseDaemonArgs(H: string[]): {
  sub: string
  jsonPath: string
  logPath: string
  origin?: DaemonOrigin
  spawnedBy?: unknown
  rest: string[]
} {
  let $ = defaultDaemonJsonPath()
  let q = false
  let K = defaultDaemonLogPath()
  let _: DaemonOrigin | undefined
  let z: unknown
  const A = new Set<number>()
  for (let J = 0; J < H.length; J++) {
    const X = H[J]!
    if (X === '--json-path' && H[J + 1]) {
      A.add(J)
      A.add(++J)
      $ = H[J]!
      q = true
    } else if (X.startsWith('--json-path=')) {
      A.add(J)
      $ = X.slice(12)
      q = true
    } else if (X === '--log-file' && H[J + 1]) {
      A.add(J)
      A.add(++J)
      K = H[J]!
    } else if (X.startsWith('--log-file=')) {
      A.add(J)
      K = X.slice(11)
    } else if (X === '--origin' && H[J + 1]) {
      A.add(J)
      A.add(++J)
      _ = parseOrigin(H[J]!)
    } else if (X.startsWith('--origin=')) {
      A.add(J)
      _ = parseOrigin(X.slice(9))
    } else if (X === '--spawned-by' && H[J + 1]) {
      A.add(J)
      A.add(++J)
      z = H[J]
    }
  }
  const Y: string[] = []
  for (let J = 0; J < H.length; J++) if (!A.has(J)) Y.push(H[J]!)
  const O = new Set([
    'run',
    'install',
    'uninstall',
    'start',
    'stop',
    'restart',
    'status',
    'logs',
    'log',
    'list',
    'scheduled',
    'assistant',
    'remote-control',
    'hub',
  ])
  const f = process.stdin.isTTY ? 'hub' : 'run'
  let M = -1
  for (let J = 0; J < Y.length; J++) {
    if (!Y[J]!.startsWith('-')) {
      M = J
      break
    }
  }
  if (M === -1) {
    return { sub: f, jsonPath: $, logPath: K, origin: _, spawnedBy: z, rest: Y }
  }
  const j = Y[M]!
  if (!O.has(j)) {
    if (!/[./\\~]/.test(j)) {
      return { sub: j, jsonPath: $, logPath: K, origin: _, spawnedBy: z, rest: [] }
    }
    return {
      sub: 'run',
      jsonPath: q ? $ : j,
      logPath: K,
      origin: _,
      spawnedBy: z,
      rest: [],
    }
  }
  const w = [...Y.slice(0, M), ...Y.slice(M + 1)]
  let D = j
  if (D === 'run' && !q) {
    const J = w.find(X => !X.startsWith('-'))
    if (J) {
      $ = J
    }
  }
  return { sub: D, jsonPath: $, logPath: K, origin: _, spawnedBy: z, rest: w }
}

/**
 * Official `Bmz` `case"run"`.
 */
export async function runDaemonCommand(args: string[]): Promise<void> {
  const parsed = parseDaemonArgs(args)
  if (isBackgroundAgentsDisabled()) {
    process.stderr.write(
      'claude daemon: background agents disabled (3P/opt-out)\n',
    )
    process.exit(0)
  }
  process.title = 'claude daemon'
  const O = new AbortController()
  let f = false
  const M = () => {
    if (f) {
      process.stderr.write('forced shutdown\n')
      process.exit(1)
    }
    f = true
    O.abort()
  }
  process.on('SIGINT', M)
  process.on('SIGTERM', M)
  const j = parsed.origin ?? 'foreground'
  let w = false
  let D = 1
  try {
    ;({ upgradeDetected: w, exitCode: D } = await runDaemonSupervisor({
      jsonPath: parsed.jsonPath,
      logPath: parsed.logPath,
      origin: j,
      spawnedBy: parsed.spawnedBy,
      signal: O.signal,
    }))
  } catch (J) {
    logError(J)
    featureBad('daemon_start', 'daemon_start_crash')
    process.exit(1)
  }
  if (w) {
    /* official service-origin self-restart; foreground just exits for upgrade */
  }
  process.exit(D)
}
