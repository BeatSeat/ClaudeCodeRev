import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyInternalMetadataChanged,
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
  type SessionInternalMetadata,
} from '../utils/sessionState.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { getUserIntentSetting, setUserIntentSetting } from '../utils/settings/userIntent.js'
import type { AppState } from './AppStateStore.js'

// Inverse of the push below — restore on worker restart.
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

/** Official 2.1.121 eD4 — restore session always-allow rules from internal_metadata. */
export function sessionAllowRulesToAppState(
  metadata: SessionInternalMetadata,
): (prev: AppState) => AppState {
  const raw = metadata.session_allow_rules
  if (!Array.isArray(raw)) return prev => prev
  const rules = raw.filter(
    (rule): rule is string =>
      typeof rule === 'string' && !rule.startsWith('mcp__'),
  )
  if (rules.length === 0) return prev => prev
  return prev => ({
    ...prev,
    toolPermissionContext: {
      ...prev.toolPermissionContext,
      alwaysAllowRules: {
        ...prev.toolPermissionContext.alwaysAllowRules,
        session: rules,
      },
    },
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode — single choke point for CCR/SDK mode sync.
  //
  // Prior to this block, mode changes were relayed to CCR by only 2 of 8+
  // mutation paths: a bespoke setAppState wrapper in print.ts (headless/SDK
  // mode only) and a manual notify in the set_permission_mode handler.
  // Every other path — Shift+Tab cycling, ExitPlanModePermissionRequest
  // dialog options, the /plan slash command, rewind, the REPL bridge's
  // onSetPermissionMode — mutated AppState without telling
  // CCR, leaving external_metadata.permission_mode stale and the web UI out
  // of sync with the CLI's actual mode.
  //
  // Hooking the diff here means ANY setAppState call that changes the mode
  // notifies CCR (via notifySessionMetadataChanged → ccrClient.reportMetadata)
  // and the SDK status stream (via notifyPermissionModeChanged → registered
  // in print.ts). The scattered callsites above need zero changes.
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata must not receive internal-only mode names
    // (bubble, ungated auto). Externalize first — and skip
    // the CCR notify if the EXTERNAL mode didn't change (e.g.,
    // default→bubble→default is noise from CCR's POV since both
    // externalize to 'default'). The SDK channel (notifyPermissionModeChanged)
    // passes raw mode; its listener in print.ts applies its own filter.
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan = first plan cycle only. The initial control_request
      // sets mode and isUltraplanMode atomically, so the flag's
      // transition gates it. null per RFC 7396 (removes the key).
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // Official 2.1.121 J7H: persist session "Always allow" rules (minus mcp__)
  // so remote-session worker restarts restore them via eD4.
  const prevSessionAllow = oldState.toolPermissionContext.alwaysAllowRules.session
  const nextSessionAllow = newState.toolPermissionContext.alwaysAllowRules.session
  if (prevSessionAllow !== nextSessionAllow) {
    const rules = nextSessionAllow?.filter(rule => !rule.startsWith('mcp__'))
    notifyInternalMetadataChanged({
      session_allow_rules: rules?.length ? rules : null,
    })
  }

  // Official 2.1.117: persist /model to userSettings, and to localSettings
  // when a project/local pin would otherwise win on restart.
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    const next = newState.mainLoopModel
    updateSettingsForSource('userSettings', { model: next ?? undefined })
    const projectPin = getSettingsForSource('projectSettings')?.model
    const localPin = getSettingsForSource('localSettings')?.model
    if (next !== null && (projectPin !== undefined || localPin !== undefined) && next !== projectPin) {
      updateSettingsForSource('localSettings', { model: next })
    } else if (localPin !== undefined) {
      updateSettingsForSource('localSettings', { model: undefined })
    }
    setMainLoopModelOverride(next)
  }

  // expandedView → persist as showExpandedTodos + showSpinnerTree for backwards compat
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose — Official 2.1.119: persist to userSettings (user-intent key)
  if (
    newState.verbose !== oldState.verbose &&
    getUserIntentSetting('verbose', false) !== newState.verbose
  ) {
    setUserIntentSetting('verbose', newState.verbose)
  }

  // tungstenPanelVisible (ant-only tmux panel sticky toggle)
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // settings: clear auth-related caches when settings change
  // This ensures apiKeyHelper and AWS/GCP credential changes take effect immediately
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()

      // Re-apply environment variables when settings.env changes
      // This is additive-only: new vars are added, existing may be overwritten, nothing is deleted
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
