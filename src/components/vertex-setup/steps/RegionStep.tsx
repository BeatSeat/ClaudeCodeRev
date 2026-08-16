import React, { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import TextInput from '../../TextInput.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import type { VertexWizardData } from '../types.js'
import { TextStepFooter } from '../ui.js'

export function RegionStep(): React.ReactNode {
  const { goBack, goNext, updateWizardData, wizardData } =
    useWizard<VertexWizardData>()
  const [value, setValue] = useState(wizardData.region ?? 'global')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  return (
    <WizardDialogLayout
      subtitle="Vertex AI region"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Text>Where Claude models are served from.</Text>
        <Text dimColor>
          Use 'global' for the multi-region endpoint (recommended), or a
          specific location like us-east5 if you have regional quota.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('Region is required')
                return
              }
              setError(null)
              updateWizardData({ region: trimmed })
              goNext()
            }}
            placeholder="global"
            columns={40}
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
