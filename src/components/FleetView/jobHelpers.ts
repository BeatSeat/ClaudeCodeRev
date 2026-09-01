import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration } from '../../utils/format.js'
import {
  FLEET_GROUP_LABELS,
  type FleetGroupId,
  type FleetJob,
  type FleetJobState,
} from './types.js'

/** Official 2.1.139 `Ld6` — strip C0 / C1 controls from labels. */
const CONTROL_STRIP = /[\x00-\x08\x0E-\x1F\x7F-\x9F]/g

const LABEL_BUDGET = 25

function cleanLabel(text: string): string {
  return text.replace(CONTROL_STRIP, '').replace(/\s+/g, ' ').trim()
}

function intentText(intent: string | undefined): string {
  return intent ?? ''
}

/**
 * Official 2.1.139 `Z28`.
 * Prefer `name`; else first 3 intent words (ellipsis); else `template`.
 * Origin row with no intent falls back to `current session`.
 */
export function jobLabel(state: FleetJobState, isOrigin = false): string {
  if (state.name) return cleanLabel(state.name)
  const words = cleanLabel(intentText(state.intent))
    .split(' ')
    .filter(Boolean)
  if (words.length === 0) {
    if (isOrigin) return 'current session'
    return cleanLabel(state.template ?? '')
  }
  const joined =
    words.length > 3 ? `${words.slice(0, 3).join(' ')}…` : words.join(' ')
  if (stringWidth(joined) <= LABEL_BUDGET) return joined
  let out = ''
  let width = 0
  for (const ch of joined) {
    const next = stringWidth(ch)
    if (width + next > LABEL_BUDGET - 1) break
    out += ch
    width += next
  }
  return `${out}…`
}

/** Official 2.1.139 `Sg5`. */
function formatCreatedAge(job: FleetJob): string {
  return formatDuration(Math.max(0, Date.now() - Date.parse(job.state.createdAt)), {
    mostSignificantOnly: true,
  })
}

/**
 * Official 2.1.139 `hd6`.
 * Future `nextAt` renders `in …`; otherwise age since `createdAt`.
 */
export function formatJobAge(
  job: FleetJob,
  nextAt?: number | null,
): string {
  const now = Date.now()
  if (nextAt != null && nextAt > now) {
    return `in ${formatDuration(nextAt - now, { mostSignificantOnly: true })}`
  }
  return formatCreatedAge(job)
}

/**
 * Official 2.1.139 `O28` (live-session subset — no PR-status map).
 */
export function stateBucket(
  job: FleetJob,
  sessionStatus?: 'busy' | 'idle' | 'waiting',
): keyof typeof FLEET_GROUP_LABELS {
  if (sessionStatus === 'busy') return 'working'
  if (job.activity === 'failure' || job.activity === 'stopped') return 'done'
  if (sessionStatus === 'waiting') return 'blocked'
  if (job.activity === 'success') return 'done'
  if (job.state.tempo === 'blocked') return 'blocked'
  return 'working'
}

/**
 * Official 2.1.139 `bEH` (live-session subset).
 */
export function deriveBand(
  job: FleetJob,
  sessionStatus?: 'busy' | 'idle' | 'waiting',
): 'active' | 'blocked' | 'completed' {
  if (sessionStatus === 'busy') return 'active'
  if (job.activity === 'success' || job.activity === 'failure' || job.activity === 'stopped') {
    return 'completed'
  }
  if (job.state.tempo === 'blocked' || sessionStatus === 'waiting') return 'blocked'
  return 'active'
}

export function groupLabel(group: FleetGroupId): string {
  if (group === 'pinned') return 'Pinned'
  return FLEET_GROUP_LABELS[group]
}

/** Official 2.1.153 `tM9`. */
export function fleetViewTitle(awaitingInput: number): string {
  return awaitingInput > 0
    ? `${awaitingInput} awaiting input · claude agents`
    : 'claude agents'
}

/** Official 2.1.139 `bg5` / `xg5` — clamp for fold keep-count. */
const FOLD_KEEP_MIN = 3
const FOLD_KEEP_MAX = 10

/**
 * Official 2.1.139 `ym4`.
 * `k = clamp(floor(terminal_rows / 5), 3, 10)`.
 */
export function foldKeepCount(terminalRows: number): number {
  return Math.min(
    FOLD_KEEP_MAX,
    Math.max(FOLD_KEEP_MIN, Math.floor(terminalRows / 5)),
  )
}

/** Official 2.1.139 `Dm4` — min trailing done jobs before a fold row. */
export const FOLD_EXTRA = 3

/** Official 2.1.139 `ug5` — same-age cluster window (ms) before folding. */
export const FOLD_CLUSTER_MS = 60000

/** Official 2.1.139 `hg5` — dispatch reject below this trimmed length. */
export const DISPATCH_MIN_LENGTH = 4
