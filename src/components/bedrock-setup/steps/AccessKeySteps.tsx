import React, { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import TextInput from '../../TextInput.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import type { BedrockWizardData } from '../types.js'
import { TextStepFooter } from '../ui.js'

export function AccessKeyIdStep(): React.ReactNode {
  const { goBack, goNext, updateWizardData, wizardData } =
    useWizard<BedrockWizardData>()
  const [value, setValue] = useState(wizardData.accessKeyId ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  return (
    <WizardDialogLayout
      subtitle="AWS access key ID"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('Access key ID is required')
                return
              }
              setError(null)
              updateWizardData({ accessKeyId: trimmed })
              goNext()
            }}
            placeholder="AKIA…"
            columns={60}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            focus
            showCursor
          />
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        ) : null}
      </Box>
    </WizardDialogLayout>
  )
}

export function SecretKeyStep(): React.ReactNode {
  const { goBack, goNext, updateWizardData, wizardData } =
    useWizard<BedrockWizardData>()
  const [value, setValue] = useState(wizardData.secretAccessKey ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  return (
    <WizardDialogLayout
      subtitle="AWS secret access key"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('Secret access key is required')
                return
              }
              setError(null)
              updateWizardData({ secretAccessKey: trimmed })
              goNext()
            }}
            mask="*"
            columns={60}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            focus
            showCursor
          />
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        ) : null}
      </Box>
    </WizardDialogLayout>
  )
}

export function SessionTokenStep(): React.ReactNode {
  const { goBack, goNext, updateWizardData, wizardData } =
    useWizard<BedrockWizardData>()
  const [value, setValue] = useState(wizardData.sessionToken ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  return (
    <WizardDialogLayout
      subtitle="AWS session token (optional)"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Text dimColor>
          Only needed for temporary credentials from STS. Leave empty for
          long-lived keys.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              updateWizardData({ sessionToken: value.trim() || undefined })
              goNext()
            }}
            mask="*"
            columns={60}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            focus
            showCursor
          />
        </Box>
      </Box>
    </WizardDialogLayout>
  )
}
