import React, { useMemo } from 'react'
import figures from 'figures'
import { Box, Text } from '../../ink.js'

type Props = {
  focusedPinned: boolean
  canReorder: boolean
  canRename: boolean
  canPin: boolean
  canMention: boolean
  altOpenCount: number
}

function HelpLine({ text }: { text: string }): React.ReactNode {
  return <Text dimColor>{text}</Text>
}

function HelpColumn({
  lines,
}: {
  lines: string[]
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {lines.map(line => (
        <HelpLine key={line} text={line} />
      ))}
    </Box>
  )
}

/**
 * Official 2.1.119 help chrome. Later mention-dispatch copy is stubbed out.
 */
export function FleetViewHelp({
  focusedPinned,
  canReorder,
  canRename,
  canPin,
  canMention,
  altOpenCount,
}: Props): React.ReactNode {
  const columns = useMemo(() => {
    const lines: string[] = []
    if (canReorder) {
      lines.push(`shift+${figures.arrowUp}${figures.arrowDown} to reorder`)
    }
    if (canRename) lines.push('ctrl+r to rename')
    lines.push('ctrl+s to switch views')
    void canMention
    if (canPin) {
      lines.push(`ctrl+t to ${focusedPinned ? 'unpin' : 'pin to top'}`)
    }
    if (altOpenCount > 0) {
      lines.push(`alt+1${altOpenCount > 1 ? `-${altOpenCount}` : ''} to open`)
    }
    lines.push('esc to quit')
    lines.push('? to close')
    const pairs: string[][] = []
    for (let i = 0; i < lines.length; i += 2) {
      pairs.push(lines.slice(i, i + 2))
    }
    return pairs
  }, [
    altOpenCount,
    canMention,
    canPin,
    canRename,
    canReorder,
    focusedPinned,
  ])

  return (
    <Box flexShrink={0} paddingX={2} flexDirection="row" gap={4}>
      {columns.map((lines, i) => (
        <HelpColumn key={i} lines={lines} />
      ))}
    </Box>
  )
}
