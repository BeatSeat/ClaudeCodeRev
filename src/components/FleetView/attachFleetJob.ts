import type { Root } from '../../ink.js'
import { createRoot } from '../../ink.js'
import instances from '../../ink/instances.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'
import type { FleetJobState, FleetRespawnResult } from './types.js'
import { featureBad, featureOk, featureSad } from './fleetTelemetry.js'

type AttachResult =
  | { kind: 'ok'; msg?: string }
  | { kind: 'error'; msg?: string; orphaned?: boolean; ended?: boolean }

/**
 * Official 2.1.139 `X28` leftover — job store / daemon respawn is not in
 * this tree yet. Preserves the attach-loop contract and `[FV-attach]` log.
 */
export async function respawnFleetJob(
  jobId: string,
  opts?: {
    force?: boolean
    knownState?: FleetJobState
    knownAlive?: boolean
  },
): Promise<FleetRespawnResult> {
  void jobId
  void opts?.force
  void opts?.knownState
  return {
    ok: false,
    alive: opts?.knownAlive === true,
    short: jobId,
  }
}

/**
 * Official 2.1.139 `YG4` leftover — live TTY attach is not in this tree yet.
 * `alreadyInAlt` is the official handoff flag.
 */
export async function attachFleetJob(
  shortId: string,
  opts: { alreadyInAlt: boolean },
): Promise<AttachResult> {
  void shortId
  void opts.alreadyInAlt
  return { kind: 'error', ended: true }
}

/** Official 2.1.119 alt-screen handoff — pause Ink before attach. */
export function handoffAltScreen(): void {
  const ink = instances.get(process.stdout)
  ink?.pause()
}

function restoreWindowsRawMode(): void {
  if (
    getPlatform() === 'windows' &&
    process.stdin.isTTY &&
    'setRawMode' in process.stdin
  ) {
    process.stdin.setRawMode(true)
    process.stdin.ref()
  }
}

/**
 * Official 2.1.139 `GQ5` attach / respawn / remount body (one `open` hop).
 * Returns `initialError` for the next list remount.
 */
export async function attachThenRemount(
  _root: Root,
  jobId: string,
  state: FleetJobState,
  opts: {
    alreadyInAlt: boolean
    freshDispatch?: boolean
    statuses?: Map<string, unknown>
    statusesTs?: number
    respawnResult?: FleetRespawnResult
  },
): Promise<{ root: Root; initialError?: string }> {
  const restoreAlt = opts.alreadyInAlt
    ? () => {
        void process.stdout.write('')
      }
    : () => {}

  restoreWindowsRawMode()

  const started = Date.now()
  const sessionId = state.resumeSessionId ?? state.sessionId
  const knownAlive =
    opts.statusesTs !== undefined &&
    Date.now() - opts.statusesTs < 1500 &&
    sessionId !== undefined &&
    opts.statuses?.get(sessionId) !== undefined
      ? true
      : undefined

  const respawn =
    opts.respawnResult ??
    (await respawnFleetJob(
      jobId,
      opts.freshDispatch
        ? undefined
        : { knownState: state, knownAlive },
    ))

  logForDebugging(
    `[FV-attach] respawnJob ${jobId}: ok=${respawn.ok} alive=${!respawn.ok && respawn.alive} err=${respawn.ok ? '' : (respawn.error ?? '')}`,
  )

  let initialError: string | undefined
  if (respawn.ok || respawn.alive) {
    const attachStarted = Date.now()
    const runAttach = (short: string): Promise<AttachResult> =>
      attachFleetJob(short, { alreadyInAlt: opts.alreadyInAlt }).catch(err => {
        logError(err)
        featureBad('job_attach', 'threw')
        return {
          kind: 'error' as const,
          msg: `Couldn't attach — ${errorMessage(err)}`,
        }
      })

    let result = await runAttach(respawn.short ?? jobId)
    let recovered = false
    if (result.kind === 'error' && result.orphaned) {
      const forced = await respawnFleetJob(jobId, { force: true, knownState: state })
      if (forced.ok || forced.alive) {
        recovered = true
        result = await runAttach(forced.short ?? jobId)
      } else {
        result = { kind: 'error', msg: forced.error }
      }
    }
    if (result.kind === 'error' && !result.ended) {
      initialError = result.msg
      if (recovered && result.orphaned) {
        featureSad('fleet_view_open', 'recovered_then_crashed')
      } else {
        featureBad(
          'fleet_view_open',
          recovered ? 'orphan_recovery_failed' : 'attach_failed',
        )
      }
    } else {
      if (result.msg) initialError = result.msg
      featureOk('fleet_view_open')
    }
    logForDebugging(
      `[FV-attach] attachJob returned after ${Date.now() - started}ms — remounting list`,
    )
    void attachStarted
  } else {
    initialError = respawn.error
    featureBad('fleet_view_open', 'respawn_failed')
  }

  const next = await createRoot({ exitOnCtrlC: false })
  logForDebugging('[PERF:bg-remount-start]')
  restoreAlt()
  void _root
  return { root: next, initialError }
}
