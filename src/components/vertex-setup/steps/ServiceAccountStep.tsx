import React, { useState } from 'react'
import { homedir } from 'os'
import { join } from 'path'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import TextInput from '../../TextInput.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { VERTEX_SETUP_STEPS, type VertexWizardData } from '../types.js'
import { TextStepFooter } from '../ui.js'

function expandUserPath(value: string): string {
  if (value === '~') {
    return homedir()
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

export function ServiceAccountStep(): React.ReactNode {
  const { goBack, goToStep, updateWizardData, wizardData } =
    useWizard<VertexWizardData>()
  const [value, setValue] = useState(wizardData.keyFile ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  return (
    <WizardDialogLayout
      subtitle="Service account key"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Text>Path to the service account JSON key file.</Text>
        <Text dimColor>
          Download one from the GCP console under IAM → Service Accounts → Keys
          → Add key.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('Path is required')
                return
              }
              setError(null)
              updateWizardData({ keyFile: expandUserPath(trimmed) })
              goToStep(VERTEX_SETUP_STEPS.PROJECT)
            }}
            placeholder="~/keys/my-project-vertex.json"
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
