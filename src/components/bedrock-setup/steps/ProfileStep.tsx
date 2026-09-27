import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { plural } from '../../../utils/stringUtils.js'
import { Select } from '../../CustomSelect/select.js'
import TextInput from '../../TextInput.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { listAwsProfiles } from '../helpers.js'
import { BEDROCK_SETUP_STEPS, type BedrockWizardData } from '../types.js'
import { TextStepFooter, WizardSpinner } from '../ui.js'

const MANUAL_VALUE = '__manual__'
const MAX_LISTED_PROFILES = 12

type Phase =
  | { phase: 'loading' }
  | { phase: 'ready'; profiles: string[] }

export function ProfileStep(): React.ReactNode {
  const { goBack, goToStep, updateWizardData, wizardData } =
    useWizard<BedrockWizardData>()
  const [state, setState] = useState<Phase>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    void listAwsProfiles().then(profiles => {
      if (!cancelled) {
        setState({ phase: 'ready', profiles })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (state.phase === 'loading') {
    return (
      <WizardDialogLayout subtitle="AWS profile">
        <WizardSpinner message="Reading ~/.aws/config…" />
      </WizardDialogLayout>
    )
  }

  return (
    <ProfilePicker
      profiles={state.profiles}
      wizardData={wizardData}
      goBack={goBack}
      goToStep={goToStep}
      updateWizardData={updateWizardData}
    />
  )
}

function ProfilePicker({
  profiles,
  wizardData,
  goBack,
  goToStep,
  updateWizardData,
}: {
  profiles: string[]
  wizardData: BedrockWizardData
  goBack: () => void
  goToStep: (index: number) => void
  updateWizardData: (data: Partial<BedrockWizardData>) => void
}): React.ReactNode {
  const tooMany = profiles.length > MAX_LISTED_PROFILES
  const missingCurrent = Boolean(
    wizardData.awsProfile && !profiles.includes(wizardData.awsProfile),
  )
  const [manual, setManual] = useState(
    profiles.length === 0 || tooMany || missingCurrent,
  )
  const suggested = tooMany
    ? profiles.find(name => name.toLowerCase().includes('bedrock'))
    : undefined
  const [value, setValue] = useState(wizardData.awsProfile ?? suggested ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, {
    context: 'Settings',
    isActive: manual,
  })

  const commit = (profile: string) => {
    updateWizardData({ awsProfile: profile })
    goToStep(BEDROCK_SETUP_STEPS.REGION)
  }

  if (!manual) {
    const defaultValue =
      wizardData.awsProfile && profiles.includes(wizardData.awsProfile)
        ? wizardData.awsProfile
        : undefined
    return (
      <WizardDialogLayout subtitle="AWS profile">
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            Found {profiles.length} {plural(profiles.length, 'profile')} in
            ~/.aws/config and ~/.aws/credentials.
          </Text>
          <Select
            options={[
              ...profiles.map(name => ({ label: name, value: name })),
              { label: 'Type a different name…', value: MANUAL_VALUE },
            ]}
            defaultValue={defaultValue}
            onChange={next => {
              if (next === MANUAL_VALUE) {
                setManual(true)
                return
              }
              commit(next)
            }}
            onCancel={goBack}
          />
        </Box>
      </WizardDialogLayout>
    )
  }

  return (
    <WizardDialogLayout
      subtitle="AWS profile name"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Text>The name from ~/.aws/config (after [profile …]).</Text>
        {tooMany ? (
          <Text dimColor>
            Found {profiles.length} profiles — too many to list.
            {suggested ? ` Prepopulated with "${suggested}".` : ''}
          </Text>
        ) : null}
        <Text dimColor>
          If this is an SSO profile, run `aws sso login --profile NAME` first.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('Profile name is required')
                return
              }
              setError(null)
              commit(trimmed)
            }}
            placeholder="my-bedrock-profile"
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
