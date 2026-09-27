import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import type { FleetJob } from './types.js'
import { featureBad, featureOk } from './fleetTelemetry.js'

export function canRenameJob(job: FleetJob | undefined): boolean {
  if (!job) return false
  return !(job.state.backend === 'peer' && !job.state.sock)
}

export function canPinJob(job: FleetJob | undefined): boolean {
  return !!job
}

/**
 * Official 2.1.139 `ctrl+t` pin toggle. Persist (`ybK`) is leftover —
 * optimistic local `pinned` still lands `fleet_view_pin_toggle`.
 */
export function togglePinned(
  job: FleetJob,
  apply: (next: boolean) => void,
  onError: (message: string) => void,
): void {
  if (job.state.backend === 'peer') {
    onError("Can't pin a session that's running in another terminal")
    featureOk('fleet_view_pin_toggle')
    return
  }
  const next = !job.state.pinned
  apply(next)
  Promise.resolve()
    .then(() => {
      featureOk('fleet_view_pin_toggle')
    })
    .catch(err => {
      logError(err)
      onError(`Couldn't ${next ? 'pin' : 'unpin'} — ${errorMessage(err)}`)
      featureBad('fleet_view_pin_toggle', 'pin_write_failed')
    })
}

/**
 * Official 2.1.139 rename persist (`tYH` / peer UDS). Local name apply is
 * optimistic; official failure strings stay on the leftover write path.
 */
export function renameJob(
  job: FleetJob,
  name: string,
  apply: (next: string) => void,
  onError: (message: string) => void,
): void {
  apply(name)
  if (job.state.backend === 'peer') {
    Promise.resolve()
      .then(() => {
        featureOk('fleet_view_rename_job')
      })
      .catch(err => {
        logForDebugging(`[fleetview] peer rename failed: ${err}`)
        featureBad('fleet_view_rename_job', 'peer_uds_failed')
        onError("Couldn't rename — that session isn't responding")
      })
    return
  }
  Promise.resolve(true)
    .then(ok => {
      if (ok) {
        featureOk('fleet_view_rename_job')
        return
      }
      onError(
        "Couldn't rename — the job may have been removed or its state file is unwritable.",
      )
      featureBad('fleet_view_rename_job', 'sync_name_failed')
    })
}

export type DeleteArmed = { id: string; justKilled?: boolean }

/** Official 2.1.139 `ctrl+x` arm / confirm. Daemon kill is leftover. */
export function armOrDelete(
  job: FleetJob | undefined,
  armed: DeleteArmed | null,
): { armed: DeleteArmed | null; deleted?: FleetJob } {
  if (!job) return { armed }
  if (armed?.id === job.id) {
    return { armed: null, deleted: job }
  }
  return { armed: { id: job.id, justKilled: job.activity === 'stopped' } }
}
