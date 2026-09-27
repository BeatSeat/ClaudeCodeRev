import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'

type Meta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

function asMeta(value: string): Meta {
  return value as Meta
}

/** Official 2.1.139 `hH`. */
export function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', { feature_name: asMeta(featureName) })
}

/** Official 2.1.139 `xH`. */
export function featureBad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_bad', {
    feature_name: asMeta(featureName),
    error_code: asMeta(errorCode),
  })
}

/** Official 2.1.139 `j8`. */
export function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: asMeta(featureName),
    error_code: asMeta(errorCode),
  })
}

export function bgAgentAction(action: string): void {
  logEvent('tengu_bg_agent_action', { action: asMeta(action) })
}
