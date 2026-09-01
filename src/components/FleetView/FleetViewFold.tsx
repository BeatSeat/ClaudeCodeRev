import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  hidden: number
  isFocused: boolean
  onExpand?: () => void
}

/**
 * Official 2.1.139 fold row: `"… ${hidden} more"`.
 */
export function FleetViewFold({
  hidden,
  isFocused,
  onExpand,
}: Props): React.ReactNode {
  return (
    <Box onClick={onExpand}>
      <Text dimColor={!isFocused}>
        {'\u2026 '}
        {hidden}
        {' more'}
      </Text>
    </Box>
  )
}
