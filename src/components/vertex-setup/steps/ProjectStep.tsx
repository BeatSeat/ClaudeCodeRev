import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { plural } from '../../../utils/stringUtils.js'
import { Select } from '../../CustomSelect/select.js'
import TextInput from '../../TextInput.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { listGcloudProjects } from '../helpers.js'
import { VERTEX_SETUP_STEPS, type VertexWizardData } from '../types.js'
import { TextStepFooter, WizardSpinner } from '../ui.js'

const MANUAL_VALUE = '__manual__'
const MAX_LISTED_PROJECTS = 12

type Phase =
  | { phase: 'loading' }
  | { phase: 'ready'; projects: string[] }

export function ProjectStep(): React.ReactNode {
  const { goBack, goToStep, updateWizardData, wizardData } =
    useWizard<VertexWizardData>()
  const [state, setState] = useState<Phase>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    void listGcloudProjects().then(projects => {
      if (!cancelled) {
        setState({ phase: 'ready', projects })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (state.phase === 'loading') {
    return (
      <WizardDialogLayout subtitle="GCP project">
        <WizardSpinner message="Reading ~/.config/gcloud…" />
      </WizardDialogLayout>
    )
  }

  return (
    <ProjectPicker
      projects={state.projects}
      wizardData={wizardData}
      goBack={goBack}
      goToStep={goToStep}
      updateWizardData={updateWizardData}
    />
  )
}

function ProjectPicker({
  projects,
  wizardData,
  goBack,
  goToStep,
  updateWizardData,
}: {
  projects: string[]
  wizardData: VertexWizardData
  goBack: () => void
  goToStep: (index: number) => void
  updateWizardData: (data: Partial<VertexWizardData>) => void
}): React.ReactNode {
  const tooMany = projects.length > MAX_LISTED_PROJECTS
  const missingCurrent = Boolean(
    wizardData.projectId && !projects.includes(wizardData.projectId),
  )
  const [manual, setManual] = useState(
    projects.length === 0 || tooMany || missingCurrent,
  )
  const [value, setValue] = useState(wizardData.projectId ?? '')
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, {
    context: 'Settings',
    isActive: manual,
  })

  const commit = (projectId: string) => {
    updateWizardData({ projectId })
    goToStep(VERTEX_SETUP_STEPS.REGION)
  }

  if (!manual) {
    const defaultValue =
      wizardData.projectId && projects.includes(wizardData.projectId)
        ? wizardData.projectId
        : undefined
    return (
      <WizardDialogLayout subtitle="GCP project">
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            Found {projects.length} {plural(projects.length, 'project')} in
            your gcloud configurations.
          </Text>
          <Select
            options={[
              ...projects.map(name => ({ label: name, value: name })),
              { label: 'Type a different project…', value: MANUAL_VALUE },
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
      subtitle="GCP project ID"
      footerText={<TextStepFooter />}
    >
      <Box flexDirection="column">
        <Text>The project where Vertex AI is enabled.</Text>
        {tooMany ? (
          <Text dimColor>
            Found {projects.length} projects — too many to list.
          </Text>
        ) : null}
        <Text dimColor>
          Find it with `gcloud config get-value project` or in the GCP console
          header.
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={() => {
              const trimmed = value.trim()
              if (!trimmed) {
                setError('Project ID is required')
                return
              }
              setError(null)
              commit(trimmed)
            }}
            placeholder="my-gcp-project"
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
