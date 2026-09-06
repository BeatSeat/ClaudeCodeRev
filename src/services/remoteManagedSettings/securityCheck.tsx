import React from 'react'
import { getIsInteractive } from '../../bootstrap/state.js'
import { ManagedSettingsSecurityDialog } from '../../components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.js'
import {
  extractDangerousSettings,
  hasDangerousSettings,
  hasDangerousSettingsChanged,
} from '../../components/ManagedSettingsSecurityDialog/utils.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { logEvent } from '../analytics/index.js'

export type SecurityCheckResult = 'approved' | 'rejected' | 'no_check_needed'

type ManagedSettingsSecurityHandler = (
  settings: SettingsJson,
) => Promise<SecurityCheckResult>

let managedSettingsSecurityHandler: ManagedSettingsSecurityHandler | null =
  null
let isConsentDialogPendingState = false

export function isConsentDialogPending(): boolean {
  return isConsentDialogPendingState
}

/** 121 `ZA6` — REPL/SDK can approve without a second Ink root (apply-and-continue). */
export function setManagedSettingsSecurityHandler(
  handler: ManagedSettingsSecurityHandler | null,
): void {
  managedSettingsSecurityHandler = handler
}

/**
 * Check if new remote managed settings contain dangerous settings that require user approval.
 * Shows a blocking dialog if dangerous settings have changed or been added.
 *
 * @param cachedSettings The current cached settings (may be null for first run)
 * @param newSettings The new settings fetched from the API
 * @returns 'approved' if user accepts, 'rejected' if user declines, 'no_check_needed' if no dangerous changes
 */
export async function checkManagedSettingsSecurity(
  cachedSettings: SettingsJson | null,
  newSettings: SettingsJson | null,
): Promise<SecurityCheckResult> {
  // If new settings don't have dangerous settings, no check needed
  if (
    !newSettings ||
    !hasDangerousSettings(extractDangerousSettings(newSettings))
  ) {
    return 'no_check_needed'
  }

  // If dangerous settings haven't changed, no check needed
  if (!hasDangerousSettingsChanged(cachedSettings, newSettings)) {
    return 'no_check_needed'
  }

  // Skip dialog in non-interactive mode (consistent with trust dialog behavior)
  if (!getIsInteractive()) {
    return 'no_check_needed'
  }

  // Log that dialog is being shown
  logEvent('tengu_managed_settings_security_dialog_shown', {})

  if (managedSettingsSecurityHandler) {
    const result = await managedSettingsSecurityHandler(newSettings)
    logEvent(
      result === 'approved'
        ? 'tengu_managed_settings_security_dialog_accepted'
        : 'tengu_managed_settings_security_dialog_rejected',
      {},
    )
    return result
  }

  // Show blocking dialog
  isConsentDialogPendingState = true
  return new Promise<SecurityCheckResult>(resolve => {
    void (async () => {
      const { unmount } = await render(
        <AppStateProvider>
          <KeybindingSetup>
            <ManagedSettingsSecurityDialog
              settings={newSettings}
              onAccept={() => {
                isConsentDialogPendingState = false
                logEvent('tengu_managed_settings_security_dialog_accepted', {})
                unmount()
                void resolve('approved')
              }}
              onReject={() => {
                isConsentDialogPendingState = false
                logEvent('tengu_managed_settings_security_dialog_rejected', {})
                unmount()
                void resolve('rejected')
              }}
            />
          </KeybindingSetup>
        </AppStateProvider>,
        getBaseRenderOptions(false),
      )
    })()
  })
}

/**
 * Handle the security check result by exiting if rejected
 * Returns true if we should continue, false if we should stop
 */
export function handleSecurityCheckResult(
  result: SecurityCheckResult,
): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1)
    return false
  }
  return true
}
