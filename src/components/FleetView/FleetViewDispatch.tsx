import React from 'react'
import figures from 'figures'
import { Box } from '../../ink.js'
import { SearchBox } from '../SearchBox.js'
import { DISPATCH_PLACEHOLDER } from './placeholders.js'

export function fleetDispatchPlaceholder(): string {
  return DISPATCH_PLACEHOLDER
}

type Props = {
  query: string
  cursorOffset: number
  isFocused: boolean
  isTerminalFocused: boolean
  showPointer?: boolean
}

/**
 * Official 2.1.119 dispatch field (`placeholder:"describe a task for a new session"`).
 */
export function FleetViewDispatch({
  query,
  cursorOffset,
  isFocused,
  isTerminalFocused,
  showPointer,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      <SearchBox
        query={query}
        cursorOffset={cursorOffset}
        placeholder={fleetDispatchPlaceholder()}
        prefix={showPointer ? figures.pointer : ' '}
        isFocused={isFocused}
        isTerminalFocused={isTerminalFocused}
        borderless
        width="100%"
      />
    </Box>
  )
}
