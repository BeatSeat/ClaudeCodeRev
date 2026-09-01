import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isClaudeAISubscriber } from '../auth.js'

/**
 * Official 2.1.101 `On()`: plan-dialog Ultraplan option is shown when the
 * ultraplan GrowthBook config is enabled, remote sessions are allowed, the
 * user is a claude.ai subscriber, and `tengu_ccr_bridge` is on (`xp()`).
 */
export function isUltraplanPlanOptionEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: boolean } | null>(
      'tengu_ultraplan_config',
      null,
    )?.enabled === true &&
    isPolicyAllowed('allow_remote_sessions') &&
    isClaudeAISubscriber() &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
  )
}
