import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../../utils/debug.js'
import type { FleetJob, FleetPrStatus } from './types.js'

/**
 * Official 2.1.139 `Am4`.
 * Focused list uses a tighter cadence than a blurred terminal.
 */
export function prPollInterval(focused: boolean, sinceStartMs: number): number {
  if (focused) {
    if (sinceStartMs < 30000) return 15000
    if (sinceStartMs < 300000) return 60000
    return 180000
  }
  if (sinceStartMs < 30000) return 60000
  if (sinceStartMs < 600000) return 300000
  if (sinceStartMs < 3600000) return 900000
  return 1800000
}

export function prHrefsFromJobs(jobs: FleetJob[]): string[] {
  const hrefs: string[] = []
  const seen = new Set<string>()
  for (const job of jobs) {
    for (const child of job.state.children ?? []) {
      if (child.kind === 'frame') continue
      if (seen.has(child.href)) continue
      seen.add(child.href)
      hrefs.push(child.href)
    }
  }
  return hrefs
}

export function openPrHrefs(
  hrefs: string[],
  statuses: Map<string, FleetPrStatus | null>,
): string[] {
  return hrefs.filter(href => {
    const state = statuses.get(href)?.state
    return state !== 'MERGED' && state !== 'CLOSED'
  })
}

/**
 * Official 2.1.139 `J$("tengu_fleetview_pr_batch", true)` + `UG6`/`MS7` leftover.
 * Lands the unique flag token and MERGED/CLOSED filter. Per-href GitHub
 * GraphQL (`UG6`) / batched (`MS7`) fetch is still missing.
 */
export async function pollFleetPrStatuses(
  hrefs: string[],
  previous: Map<string, FleetPrStatus | null>,
): Promise<Map<string, FleetPrStatus | null>> {
  const pending = openPrHrefs(hrefs, previous)
  if (pending.length === 0) return previous
  const batched = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_fleetview_pr_batch',
    true,
  )
  void batched
  return previous
}

/** Official 2.1.139 `[FV-poll]` follow re-pin. */
export function followRepinLog(
  was: number,
  now: number,
  followId: string,
): void {
  if (was === now) return
  logForDebugging(
    `[FV-poll] follow re-pin moved focus: was=${was} now=${now} followId=${followId}`,
  )
}
