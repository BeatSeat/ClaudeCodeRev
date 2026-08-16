import * as React from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js'

const POWERUP_HINT_MIN_COLUMNS = 44

export function General(): React.ReactNode {
  const { columns } = useTerminalSize()
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Box>
        <Text>
          Claude understands your codebase, makes edits with your permission,
          and executes commands — right from your terminal.
        </Text>
      </Box>
      {columns >= POWERUP_HINT_MIN_COLUMNS ? (
        <Box>
          <Text dimColor>
            New here? Run <Text color="suggestion">/powerup</Text> to learn the
            features most people miss.
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        <Box>
          <Text bold>Shortcuts</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth={true} />
      </Box>
    </Box>
  )
}
