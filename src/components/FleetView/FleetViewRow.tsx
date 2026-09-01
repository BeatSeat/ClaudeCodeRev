import React from 'react'
import { Box, Link, Text } from '../../ink.js'
import type { FleetChild, FleetColumnWidths, FleetJob } from './types.js'
import { FRAME_GLYPH, prChildren, prNumberFromChild } from './prColumn.js'
import { formatJobAge, jobLabel } from './jobHelpers.js'

type Props = {
  job: FleetJob
  isFocused: boolean
  isOrigin?: boolean
  cols: FleetColumnWidths
  age: string
  attaching?: boolean
  deleteArmed?: { justKilled?: boolean }
}

/**
 * Official 2.1.153 `Thz` artifact cell — width from `iyz` via `ryz.artifact`.
 */
function ArtifactCell({
  job,
  isFocused,
  width,
}: {
  job: FleetJob
  isFocused: boolean
  width: number
}): React.ReactNode {
  if (width <= 0) return null
  const prs = prChildren(job.state)
  const frames = (job.state.children ?? []).filter(c => c.kind === 'frame')
  const leadPr = prs.at(-1)
  const prNumber = leadPr ? prNumberFromChild(leadPr) : undefined

  let inner: React.ReactNode = null
  if (prs.length > 1) {
    inner = (
      <Text>
        <Text dimColor={!isFocused}>{prs.length}</Text>
        <Text dimColor> PRs</Text>
      </Text>
    )
  } else if (prs.length === 1) {
    inner =
      prNumber !== undefined ? (
        <PrNumberLink number={prNumber} url={leadPr!.href} dimColor={!isFocused} />
      ) : (
        <Text dimColor={!isFocused}>PR</Text>
      )
  } else if (leadFrame(frames, job.state.children)) {
    const frame = leadFrame(frames, job.state.children)!
    inner = (
      <Link url={frame.href}>
        <Text color="claude">
          {frames.length > 1 ? `${frames.length} ` : ''}
          {FRAME_GLYPH}
        </Text>
      </Link>
    )
  }

  return (
    <Box width={width + 2} flexShrink={0} paddingLeft={2}>
      {inner}
    </Box>
  )
}

function leadFrame(
  frames: FleetChild[],
  children: FleetChild[] | undefined,
): FleetChild | undefined {
  return frames.at(-1) ?? children?.at(-1)
}

/** Official 2.1.153 `kSH` — visual `PR` + `#N` (width matches `PR #${n}` in `iyz`). */
function PrNumberLink({
  number,
  url,
  dimColor,
}: {
  number: number
  url: string
  dimColor: boolean
}): React.ReactNode {
  const label = (
    <Text dimColor={dimColor}>
      <Text dimColor={dimColor}>PR</Text>
      <Text dimColor={dimColor}> #{number}</Text>
    </Text>
  )
  return <Link url={url}>{label}</Link>
}

/** Official 2.1.153 `Thz` (table columns only). */
export function FleetViewRow({
  job,
  isFocused,
  isOrigin = false,
  cols,
  age,
  attaching,
  deleteArmed,
}: Props): React.ReactNode {
  const label = jobLabel(job.state, isOrigin)
  const status = attaching
    ? 'opening…'
    : deleteArmed
      ? deleteArmed.justKilled
        ? 'stopped · ctrl+x again to delete'
        : 'ctrl+x again to delete'
      : job.state.tempo === 'blocked'
        ? job.state.needs ?? job.state.detail ?? ''
        : job.state.detail ?? ''

  return (
    <Box>
      <Box width={cols.label + 2} flexShrink={0}>
        <Text dimColor={!isFocused} wrap="truncate" bold={isFocused}>
          {label}
        </Text>
      </Box>
      <Box flexGrow={1} width={0} paddingLeft={2}>
        <Text dimColor wrap="truncate">
          {status}
        </Text>
      </Box>
      <ArtifactCell job={job} isFocused={isFocused} width={cols.artifact} />
      <Box
        width={cols.age + 2}
        flexShrink={0}
        paddingLeft={2}
        justifyContent="flex-end"
      >
        <Text dimColor>{age}</Text>
      </Box>
    </Box>
  )
}

export function fleetRowAge(
  job: FleetJob,
  nextAt?: number | null,
): string {
  return formatJobAge(job, nextAt)
}
