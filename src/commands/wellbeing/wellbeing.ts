import type { LocalJSXCommandOnDone } from '../../types/command.js'

// Official 2.1.149: break-reminder interval options (bundle minified JQ4).
// Index 2 (120 min) is the default, so it carries the "(default)" hint.
// Module-internal in the bundle (not among the three exported symbols).
const BREAK_INTERVALS: {
  label: string
  intervalMinutes: number | null
  hint?: string
}[] = [
  { label: 'Off', intervalMinutes: null },
  { label: 'Every 1 hour', intervalMinutes: 60 },
  { label: 'Every 2 hours', intervalMinutes: 120, hint: '(default)' },
  { label: 'Every 3 hours', intervalMinutes: 180 },
  { label: 'Every 4 hours', intervalMinutes: 240 },
]

// Official 2.1.149: quiet-hours window options (bundle minified XQ4).
// The en-dash separator is the \u2013 escape, matching the bundle verbatim.
// Module-internal in the bundle (not among the three exported symbols).
const QUIET_HOURS: {
  label: string
  range: { start: string; end: string } | null
}[] = [
  { label: 'Off', range: null },
  { label: '22:00 \u2013 07:00', range: { start: '22:00', end: '07:00' } },
  { label: '23:00 \u2013 06:00', range: { start: '23:00', end: '06:00' } },
  { label: '00:00 \u2013 07:00', range: { start: '00:00', end: '07:00' } },
]

/**
 * Nearest break-interval index for a configured `intervalMinutes` (bundle
 * minified WqA). Returns 0 (Off) when unset. NOTE: faithful to the bundle,
 * the nearest match is measured against `fallbackMinutes` (default 120), not
 * against the raw configured value.
 */
export function initialIndexFor(
  intervalMinutes: number | null | undefined,
  fallbackMinutes?: number,
): number {
  if (!intervalMinutes) return 0
  const fallback = fallbackMinutes ?? 120
  let bestIndex = 1
  let bestDistance = Infinity
  for (let index = 1; index < BREAK_INTERVALS.length; index++) {
    const candidate = BREAK_INTERVALS[index].intervalMinutes ?? 0
    const distance = Math.abs(candidate - fallback)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  }
  return bestIndex
}

/**
 * Quiet-hours index for a configured window (bundle minified ZqA). Returns 0
 * (Off) unless the window exactly matches one of the presets.
 */
export function initialQuietIndexFor(range?: {
  enabled?: boolean
  start?: string
  end?: string
}): number {
  if (!range?.enabled || !range.start || !range.end) return 0
  for (let index = 1; index < QUIET_HOURS.length; index++) {
    const candidate = QUIET_HOURS[index].range
    if (
      candidate &&
      candidate.start === range.start &&
      candidate.end === range.end
    ) {
      return index
    }
  }
  return 0
}

/**
 * Stub call (bundle minified GqA). The /wellbeing UX is not wired up in this
 * build, so it always surfaces a single notice and returns null.
 */
export async function call(onDone: LocalJSXCommandOnDone): Promise<null> {
  onDone('Wellbeing settings are not available in this build')
  return null
}
