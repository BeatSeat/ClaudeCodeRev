import { stringWidth } from '../../ink/stringWidth.js'
import type { FleetChild, FleetColumnWidths, FleetJob, FleetJobState } from './types.js'
import { formatJobAge, jobLabel } from './jobHelpers.js'

/** Official 2.1.153 `b3H` — frame glyph when the artifact column is not a PR. */
export const FRAME_GLYPH = '\u29C9'

/** Official 2.1.153 `gyz` / `cyz`. */
const AGE_MIN_WIDTH = 3
const LABEL_PAD = 2
const LABEL_MIN = 12
const LABEL_MAX = 40

/**
 * Official 2.1.139 `D28` / 2.1.153 `PS$`.
 * PR number from `#N` or `/pull/N`.
 */
export function parsePrRef(href: string): string | null {
  const trimmed = href.trim()
  if (/\s/.test(trimmed)) return null
  return (/^#(\d+)$/.exec(trimmed) ?? /\/pull\/(\d+)(?!\d)/.exec(trimmed))?.[1] ?? null
}

/**
 * Official 2.1.153 `Yj9`.
 * PR number from `href` (`#N` / `/pull/N`) or a numeric `id`.
 */
export function prNumberFromChild(child: FleetChild): number | undefined {
  const fromHref = parsePrRef(child.href)
  if (fromHref !== null) return Number(fromHref)
  return /^\d+$/.test(child.id) ? Number(child.id) : undefined
}

/**
 * Official 2.1.153 `iyz`.
 * Width of the artifact / PR column for one job.
 */
export function iyz(state: FleetJobState): number {
  const children = state.children
  if (!children?.length) return 0
  const prs = children.filter(child => child.kind !== 'frame')
  if (prs.length > 1) return stringWidth(`${prs.length} PRs`)
  if (prs.length === 1) {
    const n = prNumberFromChild(prs[0]!)
    return stringWidth(n !== undefined ? `PR #${n}` : 'PR')
  }
  return stringWidth(
    children.length > 1 ? `${children.length} ${FRAME_GLYPH}` : FRAME_GLYPH,
  )
}

function hasJobColor(color: string | undefined): boolean {
  return color !== undefined && color !== ''
}

/**
 * Official 2.1.153 `ryz`.
 * Column widths for the fleet table (`artifact` comes from `iyz`).
 */
export function ryz(
  jobs: FleetJob[],
  nextAt?: (job: FleetJob) => number | null | undefined,
  originId?: string,
): FleetColumnWidths {
  const age = Math.max(
    AGE_MIN_WIDTH,
    ...jobs.map(job => stringWidth(formatJobAge(job, nextAt?.(job)))),
  )
  const label = Math.min(
    LABEL_MAX,
    Math.max(
      LABEL_MIN,
      ...jobs.map(
        job =>
          stringWidth(jobLabel(job.state, job.id === originId)) +
          (hasJobColor(job.state.color) ? 2 : 0),
      ),
    ),
  )
  const artifact = Math.max(0, ...jobs.map(job => iyz(job.state)))
  return { age, label, prefix: LABEL_PAD + label, artifact }
}

export function prChildren(state: FleetJobState): FleetChild[] {
  return (state.children ?? []).filter(child => child.kind !== 'frame')
}

export function frameChildren(state: FleetJobState): FleetChild[] {
  return (state.children ?? []).filter(child => child.kind === 'frame')
}
