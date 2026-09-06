import * as React from 'react'
import { getOauthProfileFromApiKey } from 'src/services/oauth/getOauthProfile.js'
import { isClaudeAISubscriber } from 'src/utils/auth.js'
import { Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { claimOnceFireKey } from '../useOnceFire.js'
import { useStartupNotification } from './useStartupNotification.js'

const MAX_SHOW_COUNT = 3

/** Official 2.1.179 `iF5` — mark subscription-switch notice shown. */
function markSubscriptionSwitchShown(): void {
  saveGlobalConfig(current => ({
    ...current,
    subscriptionNoticeCount: (current.subscriptionNoticeCount ?? 0) + 1,
  }))
  logEvent('tengu_switch_to_subscription_notice_shown', {})
}

/**
 * Hook to check if the user has a subscription on Console but isn't logged into it.
 */
export function useCanSwitchToExistingSubscription(): void {
  useStartupNotification(async () => {
    if ((getGlobalConfig().subscriptionNoticeCount ?? 0) >= MAX_SHOW_COUNT) {
      return null
    }
    const subscriptionType = await getExistingClaudeSubscription()
    if (subscriptionType === null) return null

    // Official 2.1.179 `S4H("subscription-switch", iF5)` — once-fire mark
    if (claimOnceFireKey('subscription-switch')) {
      markSubscriptionSwitchShown()
    }

    return {
      key: 'switch-to-subscription',
      jsx: (
        <Text color="suggestion">
          Use your existing Claude {subscriptionType} plan with Claude Code
          <Text color="text" dimColor>
            {' '}
            · /login to activate
          </Text>
        </Text>
      ),
      priority: 'low',
    }
  })
}

/**
 * Checks if the user has a subscription but is not currently logged into it.
 * This helps inform users they should run /login to access their subscription.
 */
async function getExistingClaudeSubscription(): Promise<'Max' | 'Pro' | null> {
  // If already using subscription auth, there is nothing to switch to
  if (isClaudeAISubscriber()) {
    return null
  }
  const profile = await getOauthProfileFromApiKey()
  if (!profile) {
    return null
  }

  if (profile.account.has_claude_max) {
    return 'Max'
  }

  if (profile.account.has_claude_pro) {
    return 'Pro'
  }

  return null
}
