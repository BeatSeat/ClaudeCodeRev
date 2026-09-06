import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  formatPlanLimitsEndDate,
  getFable5LaunchConfig,
  isFableOverageRequired,
  isFablePermanentAccess,
} from '../../utils/model/fableOverages.js'
import {
  getDefaultFableModel,
  isFableAvailable,
  isFableClassifierMainModel,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { getAPIProvider } from '../../utils/model/providers.js'

/** Official 2.1.170 `ii5`. */
function incrementFable5LaunchShown(): void {
  logEvent('tengu_fable5_launch_shown', {})
}

/**
 * Official 2.1.178 `xg8` — first-party + Fable available + default Fable
 * allowlisted + launch not disabled.
 */
export function shouldShowFable5Notice(): boolean {
  if (getAPIProvider() !== 'firstParty') return false
  if (!isFableAvailable()) return false
  if (!isModelAllowed(getDefaultFableModel())) return false
  return getFable5LaunchConfig().enabled !== false
}

/** Official 2.1.170 `NA4` / 2.1.178 `u39`. */
export function Fable5Notice(): React.ReactNode {
  const [show] = useState(shouldShowFable5Notice)
  const model = useMainLoopModel()
  // Official 2.1.178 `cj` — canonical Fable 5 or ANTHROPIC_DEFAULT_FABLE_MODEL.
  const isOnFable5 = isFableClassifierMainModel(model)
  const isFirstParty = getAPIProvider() === 'firstParty'
  const launch = getFable5LaunchConfig()
  const planLimitsUntil = formatPlanLimitsEndDate(launch.planLimitsEndDate)

  useEffect(() => {
    incrementFable5LaunchShown()
  }, [])

  if (!show) return null

  // Official 2.1.178 `u39`: firstParty && !LQ() && !GE()
  const planLimits =
    isFirstParty && !isFableOverageRequired() && !isFablePermanentAccess() ? (
      <Text dimColor>
        Included in your plan limits{' '}
        {planLimitsUntil ? `until ${planLimitsUntil}` : 'for a limited time'}
        , then switch to usage credits to continue.
      </Text>
    ) : null

  if (isOnFable5) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="claude" bold>
            Fable 5 is here!
          </Text>{' '}
          Our newest model for complex, long-running work.
        </Text>
        {planLimits}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        Meet{' '}
        <Text color="claude" bold>
          Fable 5
        </Text>
        , our newest model for complex, long-running work. Switch anytime with
        /model.
      </Text>
      {planLimits}
    </Box>
  )
}
