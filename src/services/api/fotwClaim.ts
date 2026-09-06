import axios from 'axios'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

/** Official 2.1.157 `gS$`. */
export const FOTW_CLAIM_NOTIFICATION_KEY = 'fotw-claim'

/** Official 2.1.157 `Kkz` — pending toast. */
export const FOTW_PENDING_TIMEOUT_MS = 60_000

/** Official 2.1.157 `D1q` — granted/failed toast + AppState clear. */
export const FOTW_GRANTED_FAILED_TIMEOUT_MS = 30_000

/** Official 2.1.157 `K34`. */
const FOTW_CAMPAIGN = 'feature_of_the_week'

/** Official 2.1.157 `_34`. */
const FOTW_CACHE_TTL_MS = 86_400_000

/** Official 2.1.157 `ME_`. */
const FOTW_GROWTHBOOK_FEATURE = 'tengu_lilac_loom'

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND'])

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

const fotwCampaignSchema = z.object({
  feature: z.string().min(1),
  command: z.string().min(1).optional(),
  week: z.string().min(1),
  amountMinorUnits: z.number().int().positive(),
  commandBlurb: z.string().min(1).optional(),
  tipBlurb: z.string().min(1).optional(),
  redeemBy: z.string().min(1).optional(),
})

type FotwCampaign = z.infer<typeof fotwCampaignSchema>

export type FotwClaim = {
  phase: 'pending' | 'granted' | 'failed' | 'needs_payment_setup'
  command: string
  amountMinorUnits: number
  currency: string
}

type FotwEligibilityInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

type FotwEligibilityResponse = FotwEligibilityInfo

function asMeta(
  value: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', { feature_name: asMeta(featureName) })
}

function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: asMeta(featureName),
    error_code: asMeta(errorCode),
  })
}

function currencySymbol(code: string): string {
  const upper = code.toUpperCase()
  return CURRENCY_SYMBOLS[upper] ?? `${upper} `
}

/** Official 2.1.157 `Kf(..., "precise")`. */
export function formatCreditAmountPrecise(
  amountMinorUnits: number,
  currency: string,
): string {
  const upper = currency.toUpperCase()
  const symbol = currencySymbol(upper)
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) {
    return `${symbol}${Math.round(amountMinorUnits)}`
  }
  return `${symbol}${(amountMinorUnits / 100).toFixed(2)}`
}

/** Official 2.1.157 `As`. */
function getFotwCampaign(): FotwCampaign | null {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    FOTW_GROWTHBOOK_FEATURE,
    null,
  )
  if (raw === null || raw === undefined) return null
  const parsed = fotwCampaignSchema.safeParse(raw)
  if (!parsed.success) {
    logForDebugging(
      `FotW campaign payload failed validation: ${parsed.error.message}`,
      { level: 'warn' },
    )
    return null
  }
  return parsed.data
}

/** Official 2.1.157 `EHH`: Claude.ai OAuth + max/pro. */
function isFotwSubscriberEligible(): boolean {
  if (!isClaudeAISubscriber()) return false
  const subscriptionType = getSubscriptionType()
  return subscriptionType === 'max' || subscriptionType === 'pro'
}

function hasClaimedFeature(orgId: string, feature: string): boolean {
  const claimed = getGlobalConfig().fotwClaimedFeatures
  return Boolean(claimed?.[orgId]?.includes(feature))
}

function markFeatureClaimed(orgId: string, feature: string): void {
  saveGlobalConfig(prev => {
    const existing = prev.fotwClaimedFeatures?.[orgId] ?? []
    if (existing.includes(feature)) return prev
    return {
      ...prev,
      fotwClaimedFeatures: {
        ...prev.fotwClaimedFeatures,
        [orgId]: [...existing, feature],
      },
    }
  })
}

/** Official 2.1.157 `KH$`. */
function getCachedFotwEligibility(
  orgId: string,
  feature: string,
): FotwEligibilityInfo | null {
  const cached = getGlobalConfig().fotwEligibilityCache?.[orgId]?.[feature]
  if (!cached) return null
  if (Date.now() - cached.timestamp > FOTW_CACHE_TTL_MS) return null
  return cached.info
}

/** Official 2.1.157 `M34`. */
function writeFotwEligibilityCache(
  orgId: string,
  feature: string,
  info: FotwEligibilityInfo,
  { onlyIfAbsent = false }: { onlyIfAbsent?: boolean } = {},
): void {
  saveGlobalConfig(prev => {
    const existing = prev.fotwEligibilityCache?.[orgId]?.[feature]
    const fresh =
      existing !== undefined &&
      Date.now() - existing.timestamp <= FOTW_CACHE_TTL_MS
    if (onlyIfAbsent && fresh) return prev
    if (
      existing &&
      existing.info.available === info.available &&
      existing.info.eligible === info.eligible &&
      existing.info.granted === info.granted &&
      existing.info.amount_minor_units === info.amount_minor_units &&
      existing.info.currency === info.currency &&
      fresh
    ) {
      return prev
    }
    return {
      ...prev,
      fotwEligibilityCache: {
        ...prev.fotwEligibilityCache,
        [orgId]: {
          ...prev.fotwEligibilityCache?.[orgId],
          [feature]: { info, timestamp: Date.now() },
        },
      },
    }
  })
}

/** Official 2.1.157 `mQ6`. */
function getFotwEligibilityContext(): {
  campaign: FotwCampaign
  orgId: string
} | null {
  const campaign = getFotwCampaign()
  if (!campaign) return null
  if (!isFotwSubscriberEligible()) return null
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  if (hasClaimedFeature(orgId, campaign.feature)) return null
  return { campaign, orgId }
}

let inflightRefresh: Promise<void> | null = null

/** Official 2.1.157 `wE_`. */
async function refreshFotwEligibilityUncached(): Promise<void> {
  const ctx = getFotwEligibilityContext()
  if (!ctx) return
  const { campaign, orgId } = ctx
  if (getCachedFotwEligibility(orgId, campaign.feature) !== null) return

  let response
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/overage_credit_grant?campaign=${FOTW_CAMPAIGN}`
    response = await axios.get<FotwEligibilityResponse>(url, {
      headers: getOAuthHeaders(accessToken),
      timeout: 10_000,
      validateStatus: status => status < 500,
    })
  } catch (err) {
    featureSad('api_fotw_eligibility_fetch', 'request_failed')
    logForDebugging(`FotW eligibility fetch failed: ${err}`, { level: 'warn' })
    return
  }

  if (response.status >= 400) {
    featureSad('api_fotw_eligibility_fetch', 'unavailable')
    return
  }

  featureOk('api_fotw_eligibility_fetch')
  if (response.data.granted) {
    markFeatureClaimed(orgId, campaign.feature)
  }
  if (getCachedFotwEligibility(orgId, campaign.feature) !== null) return
  writeFotwEligibilityCache(
    orgId,
    campaign.feature,
    {
      available: response.data.available,
      eligible: response.data.eligible,
      granted: response.data.granted,
      amount_minor_units: response.data.amount_minor_units ?? null,
      currency: response.data.currency ?? null,
    },
    { onlyIfAbsent: true },
  )
}

/**
 * Official 2.1.157 `mZ8`: single-flight eligibility poll. Hook calls this
 * on mount; the 156 inline banner is gone.
 */
export function refreshFotwEligibility(): Promise<void> {
  inflightRefresh ??= refreshFotwEligibilityUncached()
    .catch(err => {
      logForDebugging(`FotW eligibility refresh failed: ${err}`, {
        level: 'warn',
      })
    })
    .finally(() => {
      inflightRefresh = null
    })
  return inflightRefresh
}
