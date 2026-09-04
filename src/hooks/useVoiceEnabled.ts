import { useEffect, useMemo } from 'react'
import { logEvent } from '../services/analytics/index.js'
import { useAppState } from '../state/AppState.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  hasVoiceAuth,
  isVoiceGrowthBookEnabled,
} from '../voice/voiceModeEnabled.js'

let voiceInitGateLogged = false

/**
 * Combines user intent (settings.voiceEnabled) with auth + GB kill-switch.
 * Both halves live inside the memo so a stale auth read can't stick around
 * after the user re-enables voice intent — the memo re-evaluates when either
 * authVersion or userIntent changes. The auth half is the expensive one
 * (cold getClaudeAIOAuthTokens memoize → sync `security` spawn, ~60ms/call).
 * GB is a cheap cached-map lookup and stays outside the memo so a mid-session
 * kill-switch flip still takes effect on the next render.
 *
 * authVersion bumps on /login only. Background token refresh leaves it alone
 * (user is still authed), so the auth memo stays correct without re-eval.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const enabled = useMemo(
    () => userIntent && hasVoiceAuth(),
    [authVersion, userIntent],
  )
  useEffect(() => {
    if (voiceInitGateLogged) return
    voiceInitGateLogged = true
    logEvent('tengu_voice_init_gate', {
      user_intent_store: userIntent,
      user_intent_disk: getInitialSettings().voiceEnabled === true,
      has_voice_auth: hasVoiceAuth(),
      voice_mode_allowed: isVoiceGrowthBookEnabled(),
      auth_version: authVersion,
    })
  }, [])
  return enabled && isVoiceGrowthBookEnabled()
}
