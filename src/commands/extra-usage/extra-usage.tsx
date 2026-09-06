import React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  isOverageProvisioningAllowed,
} from '../../utils/auth.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { ExtraUsageDialog } from './ExtraUsageDialog.js'
import {
  applyLoginHooks,
  Login,
  loginSuccessMessage,
} from '../login/login.js'
import { runExtraUsage } from './extra-usage-core.js'

/**
 * Official 2.1.121 — /extra-usage interactive entry (bundle `V3$`).
 *
 * When the user is a Claude.ai subscriber with a supported (Stripe/mobile)
 * billing type and either the `tengu_ember_latch` GrowthBook flag is on or they
 * are on a pro/max plan, the new inline purchase dialog is shown. Otherwise it
 * falls back to the legacy flow (admin-request / open-browser / re-login).
 * The mock harness (`hT`) is compiled out in the shipped build, so it is
 * omitted here.
 */
function shouldShowInlineDialog(): boolean {
  const subscriptionType = getSubscriptionType()
  const isProOrMax = subscriptionType === 'pro' || subscriptionType === 'max'
  const emberLatch = getFeatureValue_CACHED_MAY_BE_STALE('tengu_ember_latch', false)
  // Bundle: (A || (isProOrMax && a1H() && !K9())) && (T$("tengu_ember_latch") || A)
  // where A = mock (always false here), a1H = isOverageProvisioningAllowed,
  // K9 = isEssentialTrafficOnly.
  return (
    (isProOrMax && isOverageProvisioningAllowed() && !isEssentialTrafficOnly()) &&
    emberLatch
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  if (shouldShowInlineDialog()) {
    return <ExtraUsageDialog onDone={onDone} />
  }

  const result = await runExtraUsage()

  if (result.type === 'message') {
    onDone(result.value)
    return null
  }

  const current = getOauthAccountInfo()
  const previousAccount = current && {
    accountUuid: current.accountUuid,
    organizationUuid: current.organizationUuid,
  }
  return (
    <Login
      startingMessage={
        'Starting new login following /usage-credits. Exit with Ctrl-C to use existing account.'
      }
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
