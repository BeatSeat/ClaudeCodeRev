import React from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { Box, Text } from '../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { permissionModeTitle } from '../utils/permissions/PermissionMode.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { AUTO_DEFAULT_NOTICE_BODY } from './AutoDefaultNoticeDialog.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

// Official 2.1.152 `fyz` — copy extracted verbatim from cometix 2.1.152 cli.js
export const AUTO_DEFAULT_NUDGE_TITLE =
  'Make auto mode your default permission mode?'

const ACCEPT_LABEL = 'Yes, set auto mode as my default permission mode'

type Props = {
  currentMode: PermissionMode
  onDone(accepted: boolean): void
}

function markSeenAutoDefaultNudge(): void {
  saveGlobalConfig(current =>
    current.hasSeenAutoDefaultNudge
      ? current
      : { ...current, hasSeenAutoDefaultNudge: true },
  )
}

export function AutoDefaultNudgeDialog({
  currentMode,
  onDone,
}: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_auto_default_nudge_shown', {
      current_mode:
        currentMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }, [currentMode])

  function onChange(value: string): void {
    if (value === 'accept') {
      updateSettingsForSource('userSettings', {
        permissions: { defaultMode: 'auto' },
      })
    }
    markSeenAutoDefaultNudge()
    logEvent('tengu_auto_default_nudge_resolved', {
      choice:
        value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      current_mode:
        currentMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onDone(value === 'accept')
  }

  return (
    <Dialog
      title={AUTO_DEFAULT_NUDGE_TITLE}
      onCancel={() => onChange('decline')}
    >
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>{AUTO_DEFAULT_NOTICE_BODY}</Text>
        </Box>
        <Box>
          <Select
            options={[
              { label: ACCEPT_LABEL, value: 'accept' },
              {
                label: `No, keep ${permissionModeTitle(currentMode).toLowerCase()}`,
                value: 'decline',
              },
            ]}
            onChange={onChange}
            onCancel={() => onChange('decline')}
          />
        </Box>
      </Box>
    </Dialog>
  )
}

/** Official 2.1.152 `jyz`. `tengu_maple_pier` ships default-false. */
export function shouldShowAutoDefaultNudge(): PermissionMode | null {
  const config = getGlobalConfig()
  if (
    !config.hasCompletedOnboarding ||
    config.hasSeenAutoDefaultNudge ||
    !getFeatureValue_CACHED_MAY_BE_STALE('tengu_maple_pier', false)
  ) {
    return null
  }
  const userDefault = getSettingsForSource('userSettings')?.permissions
    ?.defaultMode
  const otherSourceHasDefault = (
    ['projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const
  ).some(source => getSettingsForSource(source)?.permissions?.defaultMode)
  if (userDefault && userDefault !== 'auto' && !otherSourceHasDefault) {
    return userDefault as PermissionMode
  }
  return null
}
