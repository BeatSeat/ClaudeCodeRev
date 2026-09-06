import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import { REMOTE_CONTROL_DISCONNECTED_MSG } from '../../bridge/types.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { resetUserCache } from '../../utils/user.js'

export type PreviousLoginAccount = {
  accountUuid: string
  organizationUuid?: string
}

/** Official 2.1.176 `SZH` — existing trusted-device token, env or storage. */
async function hasExistingTrustedDeviceToken(): Promise<string | undefined> {
  const envToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
  if (envToken) return envToken
  const stored = (await getSecureStorage().readAsync())?.trustedDeviceToken
  return typeof stored === 'string' ? stored : undefined
}

/**
 * Official 2.1.176 `R0H`. Shared post-login hooks. Disconnects Remote Control
 * when the signed-in account changes. Returns whether an interactive RC
 * session was torn down so the success line can say so.
 */
export async function applyLoginHooks(
  context: LocalJSXCommandContext,
  success: boolean,
  opts?: {
    previousAccount?: PreviousLoginAccount
    awaitEnrollment?: boolean
  },
): Promise<{ bridgeDisconnected: boolean }> {
  context.onChangeAPIKey()
  context.setMessages(stripSignatureBlocks)
  if (!success) return { bridgeDisconnected: false }

  resetCostState()
  void refreshRemoteManagedSettings()
  void refreshPolicyLimits()
  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  const previous = opts?.previousAccount
  const current = getOauthAccountInfo()
  const sameAccount =
    previous?.accountUuid !== undefined &&
    previous.accountUuid === current?.accountUuid &&
    previous.organizationUuid === current?.organizationUuid
  const { replBridgeEnabled, replBridgeOutboundOnly } = context.getAppState()
  const accountChanged =
    previous?.accountUuid !== undefined && !sameAccount && replBridgeEnabled
  const bridgeDisconnected = accountChanged && !replBridgeOutboundOnly
  if (accountChanged) {
    logForDebugging(
      '[bridge:repl] Account changed via /login — disconnecting Remote Control session',
    )
    context.setAppState(prev =>
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

  if (sameAccount && (await hasExistingTrustedDeviceToken())) {
    logForDebugging(
      '[trusted-device] Same account+org re-login with existing token, skipping re-enrollment',
    )
  } else {
    clearTrustedDeviceToken()
    const enrollment = enrollTrustedDevice()
    if (opts?.awaitEnrollment) await enrollment
  }

  resetBypassPermissionsCheck()
  const appState = context.getAppState()
  void checkAndDisableBypassPermissionsIfNeeded(
    appState.toolPermissionContext,
    context.setAppState,
  )
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
  }
  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))
  return { bridgeDisconnected }
}

export function loginSuccessMessage(bridgeDisconnected: boolean): string {
  return bridgeDisconnected
    ? `Login successful. ${REMOTE_CONTROL_DISCONNECTED_MSG}`
    : 'Login successful'
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const current = getOauthAccountInfo()
  const previousAccount = current && {
    accountUuid: current.accountUuid,
    organizationUuid: current.organizationUuid,
  }
  return (
    <Login
      onDone={async success => {
        const { bridgeDisconnected } = await applyLoginHooks(context, success, {
          previousAccount,
        })
        onDone(
          success ? loginSuccessMessage(bridgeDisconnected) : 'Login interrupted',
        )
      }}
    />
  )
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const urlOutdent = useIsInsideModal() ? 1 : 2

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={() => props.onDone(true, mainLoopModel)}
        startingMessage={props.startingMessage}
        urlOutdent={urlOutdent}
      />
    </Dialog>
  )
}
