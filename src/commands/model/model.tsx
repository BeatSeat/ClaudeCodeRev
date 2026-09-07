import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { ModelPicker } from '../../components/ModelPicker.js'
import {
  getIsRemoteMode,
  getTotalOutputTokens,
} from '../../bootstrap/state.js'
import { CacheMissWarningDialog } from './CacheMissWarningDialog.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { EffortLevel } from '../../utils/effort.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
  renderModelName,
} from '../../utils/model/model.js'
import { persistModelAsDefault } from '../../utils/model/persistModelDefault.js'
import { validateModelSwitch } from '../../utils/model/validateModelSwitch.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsForSource,
  getSourceForSetting,
} from '../../utils/settings/settings.js'
import type { SettingSource } from '../../utils/settings/constants.js'

function pinDisplayName(model: string): string {
  if (model === 'opusplan') {
    return 'Opus Plan'
  }
  return renderModelName(parseUserSpecifiedModel(model))
}

/** Official 2.1.117 Fx1 — /model confirmation when a project/managed pin still applies on restart. */
function formatModelPinNote(
  selected: string | null,
  source: SettingSource | null,
  pinnedModel: string | undefined,
): string {
  if (pinnedModel === undefined || selected === pinnedModel) {
    return ''
  }
  const localPath = getRelativeSettingsFilePathForSource('localSettings')
  switch (source) {
    case 'policySettings':
      return chalk.dim(
        `\n     Managed settings pin ${chalk.bold(pinDisplayName(pinnedModel))} — that applies on restart`,
      )
    case 'projectSettings':
    case 'localSettings': {
      const pinPath =
        source === 'localSettings'
          ? localPath
          : getRelativeSettingsFilePathForSource('projectSettings')
      if (selected !== null) {
        return chalk.dim(
          `\n     Also saved to ${localPath} to override the pin in ${pinPath}`,
        )
      }
      return chalk.dim(
        `\n     ${pinPath} pins ${chalk.bold(pinDisplayName(pinnedModel))} — that applies on restart`,
      )
    }
    default:
      return ''
  }
}

function ModelPickerWrapper({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const [pendingSwitch, setPendingSwitch] = React.useState<{
    model: string | null
    effort: EffortLevel | undefined
  } | null>(null)
  const persistAsDefaultRef = React.useRef(false)

  function handleCancel(): void {
    logEvent('tengu_model_command_menu', {
      action:
        'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const displayModel = renderModelLabel(mainLoopModel)
    onDone(`Kept model as ${chalk.bold(displayModel)}`, {
      display: 'system',
    })
  }

  function resolveModelKey(model: string | null): string {
    return parseUserSpecifiedModel(model ?? getDefaultMainLoopModelSetting())
  }

  function handleSelect(
    model: string | null,
    effort: EffortLevel | undefined,
  ): void {
    if (
      getTotalOutputTokens() > 0 &&
      resolveModelKey(model) !==
        resolveModelKey(mainLoopModelForSession ?? mainLoopModel)
    ) {
      setPendingSwitch({ model, effort })
      return
    }
    applyModel(model, effort)
  }

  function applyModel(
    model: string | null,
    effort: EffortLevel | undefined,
  ): void {
    logEvent('tengu_model_command_menu', {
      action:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model:
        mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
    }))

    const persist = persistAsDefaultRef.current
    persistAsDefaultRef.current = false
    if (persist) {
      persistModelAsDefault(model)
    }
    let message = `Set model to ${chalk.bold(renderModelLabel(model))}${persist ? ' and saved as your default for new sessions' : ' for this session only'}`
    if (effort !== undefined) {
      message += ` with ${chalk.bold(effort)} effort`
    }

    // Turn off fast mode if switching to unsupported model
    let wasFastModeToggledOn = undefined
    if (isFastModeEnabled()) {
      clearFastModeCooldown()
      if (!isFastModeSupportedByModel(model) && isFastMode) {
        setAppState(prev => ({
          ...prev,
          fastMode: false,
        }))
        wasFastModeToggledOn = false
        // Do not update fast mode in settings since this is an automatic downgrade
      } else if (
        isFastModeSupportedByModel(model) &&
        isFastModeAvailable() &&
        isFastMode
      ) {
        message += ` · Fast mode ON`
        wasFastModeToggledOn = true
      }
    }

    if (wasFastModeToggledOn === false) {
      // Fast mode was toggled off, show suffix after extra usage billing
      message += ` · Fast mode OFF`
    }

    onDone(message)
  }

  if (pendingSwitch) {
    return (
      <CacheMissWarningDialog
        toModelLabel={renderModelLabel(pendingSwitch.model)}
        onConfirm={() => {
          const next = pendingSwitch
          setPendingSwitch(null)
          applyModel(next.model, next.effort)
        }}
        onCancel={() => setPendingSwitch(null)}
      />
    )
  }

  return (
    <ModelPicker
      initial={mainLoopModel}
      sessionModel={mainLoopModelForSession}
      onSelect={handleSelect}
      onSetDefault={() => {
        persistAsDefaultRef.current = true
      }}
      skipSettingsWrite
      onCancel={handleCancel}
      isStandaloneCommand
      showFastModeNotice={
        isFastModeEnabled() &&
        isFastMode &&
        isFastModeSupportedByModel(mainLoopModel) &&
        isFastModeAvailable()
      }
    />
  )
}

function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      // Official 2.1.187 `I9t` — entitlement + allowlist + 1M + API validate
      const result = await validateModelSwitch(args)
      if (result.ok === false) {
        onDone(result.message, { display: 'system' })
        return
      }
      setModel(result.model)
    }

    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
      }))
      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`

      let wasFastModeToggledOn = undefined
      if (isFastModeEnabled()) {
        clearFastModeCooldown()
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev => ({
            ...prev,
            fastMode: false,
          }))
          wasFastModeToggledOn = false
          // Do not update fast mode in settings since this is an automatic downgrade
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · Fast mode ON`
          wasFastModeToggledOn = true
        }
      }

      if (wasFastModeToggledOn === false) {
        // Fast mode was toggled off, show suffix after extra usage billing
        message += ` · Fast mode OFF`
      }

      const pinSource = getSourceForSetting('model')
      const pinnedModel = pinSource
        ? getSettingsForSource(pinSource)?.model
        : undefined
      message += formatModelPinNote(modelValue, pinSource, pinnedModel)

      onDone(message)
    }

    void handleModelChange()
  }, [args, isFastMode, onDone, setAppState])

  return null
}

function ShowModelAndClose({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const displayModel = renderModelLabel(mainLoopModel)
  const effortInfo =
    effortValue !== undefined ? ` (effort: ${effortValue})` : ''

  if (mainLoopModelForSession) {
    onDone(
      `Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`,
    )
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`)
  }

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ShowModelAndClose onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Run /model to open the model selection menu, or /model [modelName] to set the model.',
      { display: 'system' },
    )
    return
  }

  if (args) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={args} onDone={onDone} />
  }

  if (getIsRemoteMode()) {
    onDone(
      'Model picker shows local options in remote sessions \u2014 pass a model name, e.g. /model sonnet',
      { display: 'system' },
    )
    return
  }

  return <ModelPickerWrapper onDone={onDone} />
}

function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered} (default)` : rendered
}
