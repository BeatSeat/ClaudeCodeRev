import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'

type Meta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

export function asMeta(value: string | number | boolean): Meta {
  return value as Meta
}

/** Official `c`. */
export function bgEvent(
  name: string,
  metadata: Record<string, Meta | undefined> = {},
): void {
  logEvent(name, metadata)
}

/** Official 2.1.153 `RH`. */
export function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', { feature_name: asMeta(featureName) })
}

/** Official 2.1.153 `uH`. */
export function featureBad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_bad', {
    feature_name: asMeta(featureName),
    error_code: asMeta(errorCode),
  })
}

/** Official 2.1.153 `H8`. */
export function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: asMeta(featureName),
    error_code: asMeta(errorCode),
  })
}

/**
 * Official 2.1.153 `j4`. Awaits `fn`, then `tengu_feature_ok` / `tengu_feature_bad`.
 */
export async function withFeatureSpan<T>(
  name: string,
  fn: () => Promise<T>,
  errorCode?: (err: unknown) => string,
): Promise<T> {
  try {
    const result = await fn()
    featureOk(name)
    return result
  } catch (err) {
    featureBad(name, errorCode?.(err) ?? 'error')
    throw err
  }
}
