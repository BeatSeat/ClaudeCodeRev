import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { logEvent } from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  ADVISOR_LEARN_MORE_URL,
  ADVISOR_MODELS,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../../utils/advisor.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
  renderModelName,
} from '../../utils/model/model.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

function advisorLabel(model: string): string {
  return renderModelName(parseUserSpecifiedModel(model))
}

function applyAdvisor(
  choice: string,
  mainModel: string,
  setAppState: ReturnType<typeof useSetAppState>,
): string {
  logEvent('tengu_advisor_command', { advisor: choice })
  if (choice === 'off') {
    setAppState(s =>
      s.advisorModel === undefined ? s : { ...s, advisorModel: undefined },
    )
    updateSettingsForSource('userSettings', { advisorModel: undefined })
    return 'Advisor disabled'
  }
  const normalized = normalizeModelStringForAPI(choice)
  setAppState(s =>
    s.advisorModel === normalized ? s : { ...s, advisorModel: normalized },
  )
  updateSettingsForSource('userSettings', { advisorModel: normalized })
  let message = `Advisor set to ${advisorLabel(normalized)}`
  if (!modelSupportsAdvisor(mainModel)) {
    message += `\nNote: the current main model (${advisorLabel(mainModel)}) does not support the advisor. It will activate when you switch to a supported main model.`
  }
  return message
}

function matchAdvisorAlias(model: string): string | undefined {
  const lower = model.toLowerCase()
  return ADVISOR_MODELS.find(alias => lower.includes(alias))
}

function AdvisorDialog({
  onDone,
}: {
  onDone: Parameters<LocalJSXCommandCall>[0]
}): React.ReactNode {
  const advisorModel = useAppState(s => s.advisorModel)
  const mainModel = useMainLoopModel()
  const setAppState = useSetAppState()
  const matchedAlias = advisorModel ? matchAdvisorAlias(advisorModel) : undefined
  const extraOption =
    advisorModel &&
    !matchedAlias &&
    isValidAdvisorModel(parseUserSpecifiedModel(advisorModel))
      ? { label: advisorLabel(advisorModel), value: advisorModel }
      : undefined
  const options = [
    ...ADVISOR_MODELS.filter(alias =>
      isModelAllowed(parseUserSpecifiedModel(alias)),
    ).map(alias => ({
      label: advisorLabel(alias),
      value: alias,
    })),
    ...(extraOption ? [extraOption] : []),
    { label: 'No advisor', value: 'off' },
  ]
  const defaultValue = extraOption
    ? extraOption.value
    : (matchedAlias ?? 'off')

  React.useEffect(() => {
    logEvent('tengu_advisor_dialog_shown', {})
  }, [])

  return (
    <Dialog
      title="Advisor Tool (Experimental)"
      onCancel={() => onDone(undefined, { display: 'skip' })}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          When Claude needs stronger judgment — a complex decision, an
          ambiguous failure, a problem it&apos;s circling without progress —
          it escalates to the advisor model for guidance, then resumes. The
          advisor runs server-side and uses additional tokens.
        </Text>
        {!modelSupportsAdvisor(mainModel) && (
          <Text color="warning">
            The current main model ({advisorLabel(mainModel)}) does not
            support the advisor.
          </Text>
        )}
        <Select
          options={options}
          defaultValue={defaultValue}
          defaultFocusValue={defaultValue}
          onChange={value => onDone(applyAdvisor(value, mainModel, setAppState))}
          onCancel={() => onDone(undefined, { display: 'skip' })}
        />
        <Text>
          <Text color="suggestion">Recommended setup: </Text>
          <Text>
            Sonnet as the main model with Opus as the advisor. For certain
            workloads this gives near-Opus performance with reduced token
            usage.
          </Text>
        </Text>
        <Text dimColor>
          Learn more: <Link url={ADVISOR_LEARN_MORE_URL} />
        </Text>
      </Box>
    </Dialog>
  )
}

function ApplyAdvisorAndClose({
  choice,
  onDone,
}: {
  choice: string
  onDone: Parameters<LocalJSXCommandCall>[0]
}): React.ReactNode {
  const setAppState = useSetAppState()
  const mainModel = useMainLoopModel()
  const mainRef = React.useRef(mainModel)
  mainRef.current = mainModel
  const ran = React.useRef(false)

  React.useEffect(() => {
    if (ran.current) {
      return
    }
    ran.current = true
    const timer = setTimeout(() => {
      onDone(applyAdvisor(choice, mainRef.current, setAppState))
    }, 0)
    return () => clearTimeout(timer)
  }, [choice, onDone, setAppState])

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const arg = args.trim().toLowerCase()
  if (!arg) {
    return <AdvisorDialog onDone={onDone} />
  }
  if (arg === 'off' || arg === 'unset') {
    return <ApplyAdvisorAndClose choice="off" onDone={onDone} />
  }
  const resolved = parseUserSpecifiedModel(arg)
  const { valid, error } = await validateModel(resolved)
  if (!valid) {
    onDone(error ? `Invalid advisor model: ${error}` : undefined)
    return null
  }
  if (!isValidAdvisorModel(resolved)) {
    onDone(
      `${arg} cannot be used as an advisor. Valid options: ${ADVISOR_MODELS.join(', ')}, off`,
    )
    return null
  }
  return <ApplyAdvisorAndClose choice={arg} onDone={onDone} />
}
