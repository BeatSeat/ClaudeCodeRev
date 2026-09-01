/**
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * Official 2.1.126 `vO1`: Bedrock/Vertex/Foundry auto-disable analytics,
 * unless CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST (then return false).
 */
function isThirdPartyAnalyticsEnv(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return false
  }
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  )
}

/**
 * Official 2.1.126 `bb` = `vO1() || feH()`.
 * NODE_ENV === 'test' is this tree's existing extra guard (not 126 product).
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    isThirdPartyAnalyticsEnv() ||
    isTelemetryDisabled()
  )
}

/**
 * Check if the feedback survey should be suppressed.
 *
 * Unlike isAnalyticsDisabled(), this does NOT block on 3P providers
 * (Bedrock/Vertex/Foundry). The survey is a local UI prompt with no
 * transcript data — enterprise customers capture responses via OTEL.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
