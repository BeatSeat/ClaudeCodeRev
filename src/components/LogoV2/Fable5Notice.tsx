import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getCanonicalName, isFableAvailable } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'

type Fable5LaunchConfig = {
  enabled?: boolean
  planLimitsEndDate?: string
  hideRateLimitsDescription?: boolean
}

/** Official 2.1.170 `oy$` / `ci5` — GrowthBook `tengu_saffron_lattice`. */
function getFable5LaunchConfig(): Fable5LaunchConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE('tengu_saffron_lattice', {})
  if (!raw || typeof raw !== 'object') return {}
  return raw as Fable5LaunchConfig
}

/** Official 2.1.170 `ni5`. */
function formatPlanLimitsEndDate(iso: string | undefined): string | undefined {
  if (!iso) return
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/** Official 2.1.170 `ii5`. */
function incrementFable5LaunchShown(): void {
  logEvent('tengu_fable5_launch_shown', {})
}

/** Official 2.1.170 `jV8` / `li5`. */
export function shouldShowFable5Notice(): boolean {
  if (!isFableAvailable()) return false
  return getFable5LaunchConfig().enabled !== false
}

/** Official 2.1.170 `NA4`. */
export function Fable5Notice(): React.ReactNode {
  const [show] = useState(shouldShowFable5Notice)
  const model = useMainLoopModel()
  const isOnFable5 = getCanonicalName(model) === 'claude-fable-5'
  const isFirstParty = getAPIProvider() === 'firstParty'
  const launch = getFable5LaunchConfig()
  const planLimitsExpired =
    launch.planLimitsEndDate !== undefined &&
    Date.now() >= Date.parse(launch.planLimitsEndDate)
  const planLimitsUntil = formatPlanLimitsEndDate(launch.planLimitsEndDate)

  useEffect(() => {
    incrementFable5LaunchShown()
  }, [])

  if (!show) return null

  const planLimits =
    isFirstParty && !planLimitsExpired ? (
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
          Our newest model for complex, long-running work
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
        , our newest model for complex, long-running work. Try anytime with
        /model.
      </Text>
      {planLimits}
    </Box>
  )
}
