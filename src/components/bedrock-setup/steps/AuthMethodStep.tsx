import React from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { isAuthMethod } from '../helpers.js'
import { BEDROCK_SETUP_STEPS, type BedrockWizardData } from '../types.js'

const AUTH_NEXT_STEP = {
  profile: BEDROCK_SETUP_STEPS.PROFILE,
  bearer: BEDROCK_SETUP_STEPS.BEARER,
  accessKey: BEDROCK_SETUP_STEPS.ACCESS_KEY_ID,
  environment: BEDROCK_SETUP_STEPS.REGION,
} as const

export function AuthMethodStep(): React.ReactNode {
  const { goBack, goToStep, updateWizardData } = useWizard<BedrockWizardData>()

  return (
    <WizardDialogLayout subtitle="How do you authenticate to AWS?">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          Claude Code uses the standard AWS credential chain. Pick the method
          you already use with the AWS CLI.
        </Text>
        <Select
          options={[
            {
              label: 'AWS profile (SSO or named profile)',
              value: 'profile',
            },
            {
              label: 'Bedrock API key (bearer token)',
              value: 'bearer',
            },
            {
              label: 'Access key + secret',
              value: 'accessKey',
            },
            {
              label: 'Use credentials already in my environment',
              value: 'environment',
            },
          ]}
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
