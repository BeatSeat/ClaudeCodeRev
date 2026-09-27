import type { FleetJob } from './types.js'
import { deriveBand, stateBucket } from './jobHelpers.js'

export type ListedFleetJob = {
  job: FleetJob
  status?: 'busy' | 'idle' | 'waiting'
  group: ReturnType<typeof stateBucket>
  band: ReturnType<typeof deriveBand>
}

/**
 * Official 2.1.119 leftover — live PID `listLiveSessions` is 145.
 * Empty table so FleetView still mounts.
 */
export async function listFleetJobs(): Promise<ListedFleetJob[]> {
  return []
}
