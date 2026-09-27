import React from 'react'
import { Box, Text } from '../../ink.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Spinner } from '../Spinner.js'

export function WizardSpinner({
  message,
  subtitle,
  bold = false,
  dimColor = false,
}: {
  message: string
  subtitle?: string
  bold?: boolean
  dimColor?: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Spinner />
        <Text bold={bold} dimColor={dimColor}>
          {' '}
          {message}
        </Text>
      </Box>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  )
}

export function TextStepFooter(): React.ReactNode {
  return (
    <Byline>
      <KeyboardShortcutHint shortcut="Enter" action="continue" />
      <ConfigurableShortcutHint
        action="confirm:no"
        context="Settings"
        fallback="Esc"
        description="go back"
      />
    </Byline>
  )
}
