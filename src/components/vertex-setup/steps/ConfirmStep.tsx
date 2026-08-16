import React, { useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { Box, Text } from '../../../ink.js'
import { updateSettingsForSource } from '../../../utils/settings/settings.js'
import { Select } from '../../CustomSelect/select.js'
import { StatusIcon } from '../../design-system/StatusIcon.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { buildVertexEnv } from '../helpers.js'
import type { VertexWizardData } from '../types.js'

type Props = {
  onComplete: (message: string) => void
}

export function ConfirmStep({ onComplete }: Props): React.ReactNode {
  const { goBack, wizardData } = useWizard<VertexWizardData>()
  const [error, setError] = useState<string | null>(null)
  const env = buildVertexEnv(wizardData)
  const entries = Object.entries(env).filter(([, value]) => value !== undefined)

  const save = () => {
    const { error: writeError } = updateSettingsForSource('userSettings', {
      env: env as Record<string, string>,
    })
    if (writeError) {
      setError(writeError.message)
      return
    }
    logEvent('tengu_vertex_setup_complete', {
      auth_method:
        wizardData.authMethod as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      pinned_models: String(
        Boolean(
          wizardData.pinSonnet || wizardData.pinOpus || wizardData.pinHaiku,
        ),
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      verified: String(
        Boolean(wizardData.verifiedIdentity),
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onComplete(
      `Vertex AI configuration saved to ~/.claude/settings.json.${
        wizardData.authMethod === 'adc'
          ? ' When your ADC token expires, run `gcloud auth application-default login` — Claude Code picks up refreshed credentials automatically.'
          : ''
      }`,
    )
  }

  return (
    <WizardDialogLayout subtitle="Confirm and save">
      <Box flexDirection="column" gap={1}>
        <Text>These will be written to ~/.claude/settings.json under env:</Text>
        <Box flexDirection="column">
          {entries.map(([key, value]) => (
            <EnvLine key={key} name={key} value={value!} />
          ))}
        </Box>
        {wizardData.verifiedIdentity ? (
          <Text dimColor>
            <StatusIcon status="success" withSpace />
            Verified as {wizardData.verifiedIdentity}
          </Text>
        ) : null}
        {error ? <Text color="error">{error}</Text> : null}
        <Select
          options={[
            { label: 'Save', value: 'save' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={value => {
            if (value === 'save') {
              save()
            } else {
              goBack()
            }
          }}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}

function EnvLine({
  name,
  value,
}: {
  name: string
  value: string
}): React.ReactNode {
  return (
    <Text>
      {'  '}
      <Text color="suggestion">{name}</Text> = {value}
    </Text>
  )
}
