import React, { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import TextInput from '../../TextInput.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { BEDROCK_SETUP_STEPS, type BedrockWizardData } from '../types.js'
import { TextStepFooter } from '../ui.js'

export function BearerStep(): React.ReactNode {
  const { goBack, goToStep, updateWizardData, wizardData } =
    useWizard<BedrockWizardData>()
  const [value, setValue] = useState(wizardData.bearerToken ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  return (
    <WizardDialogLayout subtitle="Bedrock API key" footerText={<TextStepFooter />}>
      <Box flexDirection="column">
        <Text>Paste your Bedrock API key.</Text>
        <Text dimColor>
          Generate one in the AWS console under Bedrock → API keys.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('API key is required')
                return
              }
              setError(null)
              updateWizardData({ bearerToken: trimmed })
              goToStep(BEDROCK_SETUP_STEPS.REGION)
            }}
            placeholder="bedrock-api-key-…"
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
