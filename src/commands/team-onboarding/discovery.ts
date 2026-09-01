import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getSubscriptionType, isClaudeAISubscriber } from '../../utils/auth.js'
import { createSystemMessage } from '../../utils/messages.js'
import type { SystemInformationalMessage } from '../../types/message.js'

export type TeamOnboardingDiscoveryArm = 'off' | 'banner' | 'step'

/** Official 2.1.94 En8. */
export const TEAM_ONBOARDING_DISCOVERY_COPY = {
  heading: 'On a team?',
  body: `Ask a teammate to run /team-onboarding and share the guide.
Paste it as your first message and I'll get you set up.`,
} as const

/**
 * Official 2.1.94 K$6: Max/Pro claude.ai subscribers already have a team
 * surface, so discovery stays off.
 */
function isConsumerSubscriber(): boolean {
  if (!isClaudeAISubscriber()) return false
  const sub = getSubscriptionType()
  return sub === 'max' || sub === 'pro'
}

/**
 * Official 2.1.94 xgY (memoized). Env banner/step wins; otherwise GB
 * tengu_cedar_inlet. The discovery_shown event fires only on the GB path.
 */
export const resolveTeamOnboardingDiscoveryArm = memoize(
  (): TeamOnboardingDiscoveryArm => {
    if (isConsumerSubscriber()) return 'off'
    const env = process.env.CLAUDE_CODE_TEAM_ONBOARDING
    if (env === 'banner' || env === 'step') return env
    const arm = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_cedar_inlet',
      'off',
    ) as TeamOnboardingDiscoveryArm
    if (arm !== 'off') {
      logEvent('tengu_team_onboarding_discovery_shown', { arm })
    }
    return arm
  },
)

/** Official 2.1.94 H_5 — banner after first-run onboarding. */
export function getTeamOnboardingDiscoveryMessages(
  onboardingShown: boolean,
): SystemInformationalMessage[] {
  if (
    !onboardingShown ||
    resolveTeamOnboardingDiscoveryArm() !== 'banner'
  ) {
    return []
  }
  const { heading, body } = TEAM_ONBOARDING_DISCOVERY_COPY
  return [createSystemMessage(`${heading} ${body}`, 'suggestion')]
}
