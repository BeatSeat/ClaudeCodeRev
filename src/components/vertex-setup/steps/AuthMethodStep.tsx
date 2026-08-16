import React from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { isAuthMethod } from '../helpers.js'
import { VERTEX_SETUP_STEPS, type VertexWizardData } from '../types.js'

const AUTH_NEXT_STEP = {
  adc: VERTEX_SETUP_STEPS.PROJECT,
  serviceAccount: VERTEX_SETUP_STEPS.SERVICE_ACCOUNT,
  environment: VERTEX_SETUP_STEPS.PROJECT,
} as const

export function AuthMethodStep(): React.ReactNode {
  const { goBack, goToStep, updateWizardData, wizardData } =
    useWizard<VertexWizardData>()

  return (
    <WizardDialogLayout subtitle="How do you authenticate to Google Cloud?">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          Claude Code uses the standard GCP credential chain. Pick the method
          you already use with gcloud or in your deployment.
        </Text>
        <Select
          options={[
            {
              label: 'Application Default Credentials (gcloud auth)',
              value: 'adc',
            },
            {
              label: 'Service account key file',
              value: 'serviceAccount',
            },
            {
              label: 'Use credentials already in my environment',
              value: 'environment',
            },
          ]}
          defaultValue={wizardData.authMethod}
          onChange={value => {
            if (!isAuthMethod(value)) {
              return
            }
            updateWizardData({ authMethod: value })
            goToStep(AUTH_NEXT_STEP[value])
          }}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}
