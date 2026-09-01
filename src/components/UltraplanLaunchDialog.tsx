import * as React from 'react'
import { useMemo } from 'react'
import { CCR_TERMS_URL } from '../commands/ultraplan.js'
import { logEvent } from '../services/analytics/index.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  getUltraplanPromptIdentifier,
  getUltraplanPromptVariant,
} from '../utils/ultraplan/promptVariant.js'
import { Box, Link, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Choice = 'run' | 'cancel'

type Props = {
  onChoice: (
    choice: Choice,
    opts?: { disconnectedBridge?: boolean; promptIdentifier?: string },
  ) => void
}

/** Official 2.1.98 b45. */
export function UltraplanLaunchDialog({ onChoice }: Props): React.ReactNode {
  const firstLaunch = useMemo(
    () => !getGlobalConfig().hasSeenUltraplanTerms,
    [],
  )
  const promptIdentifier = useMemo(() => getUltraplanPromptIdentifier(), [])
  const copy = useMemo(
    () => getUltraplanPromptVariant(promptIdentifier),
    [promptIdentifier],
  )
  const replBridgeEnabled = useAppState(s => s.replBridgeEnabled)
  const setAppState = useSetAppState()

  const handleChoice = (choice: Choice) => {
    const disconnectedBridge = choice === 'run' && replBridgeEnabled
    logEvent('tengu_ultraplan_dialog_choice', {
      choice,
      first_run: firstLaunch,
      bridge_disconnected: disconnectedBridge,
      prompt_identifier: promptIdentifier,
    })
    if (disconnectedBridge) {
      setAppState(prev =>
        prev.replBridgeEnabled
          ? {
              ...prev,
              replBridgeEnabled: false,
              replBridgeExplicit: false,
              replBridgeOutboundOnly: false,
            }
          : prev,
      )
    }
    if (choice !== 'cancel' && firstLaunch) {
      logEvent('tengu_ultraplan_first_launch', {
        prompt_identifier: promptIdentifier,
      })
      saveGlobalConfig(current =>
        current.hasSeenUltraplanTerms
          ? current
          : { ...current, hasSeenUltraplanTerms: true },
      )
    }
    onChoice(choice, { disconnectedBridge, promptIdentifier })
  }

  return (
    <Dialog
      title="Run ultraplan in the cloud?"
      subtitle={copy.timeEstimate}
      onCancel={() => handleChoice('cancel')}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>{copy.dialogBody}</Text>
          {replBridgeEnabled && (
            <Text dimColor>
              This will disable Remote Control for this session.
            </Text>
          )}
          {firstLaunch && (
            <Text dimColor>
              For more information on Claude Code on the web:{' '}
              <Link url={CCR_TERMS_URL}>{CCR_TERMS_URL}</Link>
            </Text>
          )}
        </Box>
        {!replBridgeEnabled && <Text dimColor>{copy.dialogPipeline}</Text>}
        <Select
          options={[
            {
              label: 'Run ultraplan',
              value: 'run',
              description: replBridgeEnabled
                ? 'Disable remote control and launch in Claude Code on the web'
                : 'launch in Claude Code on the web',
            },
            { label: 'Not now', value: 'cancel' },
          ]}
          onChange={value => handleChoice(value as Choice)}
        />
      </Box>
    </Dialog>
  )
}
