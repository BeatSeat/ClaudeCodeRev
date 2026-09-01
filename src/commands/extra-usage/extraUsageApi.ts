/**
 * Official 2.1.121 — extra-usage inline purchase dialog API layer.
 *
 * Ported from the bundle module that backs ExtraUsageDialog (TqH/cJ7/lJ7/nJ7/iJ7/
 * rJ7/oJ7/aJ7/sJ7/tJ7 + the currency formatter q2). The bundle's in-memory mock
 * harness (hT) is compiled out in the shipped build (always null), so every mock
 * branch is dropped here. The dialog talks to the first-party
 * /api/oauth/organizations/{org}/... billing endpoints over the Claude.ai OAuth
 * bearer token.
 */
import axios from 'axios'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getOAuthHeaders,
  prepareApiRequest,
} from '../../utils/teleport/api.js'

// LP1 in the bundle — the org monthly spend limit (in cents) POSTed when
// enabling overage billing.
const DEFAULT_OVERAGE_MONTHLY_SPEND_LIMIT_CENTS = 2000

// Currency formatting (bundle WP1 symbol map / GP1 no-decimal set).
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
// Currencies without a minor-unit decimal point.
const NO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND'])

/** Bundle kUH — currency symbol, or a "<CODE> " prefix when unknown. */
function currencyLabel(currency: string): string {
  const code = currency.toUpperCase()
  return CURRENCY_SYMBOLS[code] ?? `${code} `
}

/**
 * Bundle q2 — format a minor-units amount as a displayable amount.
 * mode 'precise' (default) / 'whole' (no decimals) / 'fit' (no decimals when
 * the amount is whole).
 */
export function formatCurrency(
  amountMinorUnits: number,
  currency: string,
  mode: 'precise' | 'whole' | 'fit' = 'precise',
): string {
  const code = currency.toUpperCase()
  const symbol = currencyLabel(code)
  if (NO_DECIMAL_CURRENCIES.has(code)) {
    return `${symbol}${Math.round(amountMinorUnits)}`
  }
  const major = amountMinorUnits / 100
  if (mode === 'whole') return `${symbol}${Math.round(major)}`
  if (mode === 'fit' && major % 1 === 0) return `${symbol}${major}`
  return `${symbol}${major.toFixed(2)}`
}

/** Bundle TqH — build the org-scoped auth headers for the billing API. */
async function getOrgAuthContext(): Promise<{
  headers: Record<string, string>
  orgUUID: string
  baseUrl: string
}> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    headers: {
      ...getOAuthHeaders(accessToken),
      'User-Agent': getClaudeCodeUserAgent(),
      'x-organization-uuid': orgUUID,
    },
    orgUUID,
    baseUrl: getOauthConfig().BASE_API_URL,
  }
}

/**
 * Bundle dJ7 — extract a user-facing error message from a Stripe/API error
 * when the server marked it error_visibility: "user_facing".
 */
export function getUserFacingPurchaseError(error: unknown): string | null {
  const axiosError = error as {
    isAxiosError?: boolean
    response?: {
      data?: {
        error?: {
          details?: { error_visibility?: string }
          message?: string
        }
      }
    }
  }
  if (!axiosError.isAxiosError) return null
  const dataError = axiosError.response?.data?.error
  if (dataError?.details?.error_visibility !== 'user_facing') return null
  return dataError.message ?? null
}

/** Bundle cJ7 — enable overage billing for the org. */
export async function enableExtraUsage(): Promise<boolean> {
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    await axios.post(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/setup_overage_billing`,
      {
        org_monthly_spend_limit: DEFAULT_OVERAGE_MONTHLY_SPEND_LIMIT_CENTS,
      },
      { headers },
    )
    await axios.put(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/overage_spend_limit`,
      { is_enabled: true },
      { headers },
    )
    return true
  } catch (error) {
    logForDebugging(`enableExtraUsage failed: ${String(error)}`, {
      level: 'error',
    })
    return false
  }
}

/** Bundle lJ7 — set the org monthly spend limit (cents; null = unlimited). */
export async function adjustSpendLimit(
  cents: number | null,
  currency: string,
): Promise<boolean> {
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    await axios.put(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/overage_spend_limit`,
      {
        is_enabled: true,
        monthly_credit_limit: cents,
        currency,
      },
      { headers },
    )
    return true
  } catch (error) {
    logForDebugging(`adjustSpendLimit failed: ${String(error)}`, {
      level: 'error',
    })
    return false
  }
}

/** Bundle nJ7 — update auto-reload (recurring top-up) settings. */
export async function updateAutoReload(
  enabled: boolean,
  thresholdCents: number | undefined,
  reloadToCents: number | undefined,
  currency: string,
): Promise<boolean> {
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    await axios.put(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/contracts/auto_reload_settings`,
      {
        enabled,
        ...(thresholdCents !== undefined && {
          threshold_in_minor_units: thresholdCents,
        }),
        ...(reloadToCents !== undefined && {
          reload_to_in_minor_units: reloadToCents,
        }),
        currency,
      },
      { headers },
    )
    return true
  } catch (error) {
    logForDebugging(`updateAutoReload failed: ${String(error)}`, {
      level: 'error',
    })
    return false
  }
}

export type ExtraUsageBalance = {
  amount?: number
  currency?: string
  auto_reload_settings?: { enabled?: boolean }
}

/** Bundle iJ7 — read the prepaid-credits balance + auto-reload state. */
export async function getPrepaidBalance(): Promise<ExtraUsageBalance | null> {
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    return (
      await axios.get(
        `${baseUrl}/api/oauth/organizations/${orgUUID}/prepaid/credits`,
        { headers, timeout: 5000 },
      )
    ).data
  } catch (error) {
    logForDebugging(`getPrepaidBalance failed: ${String(error)}`, {
      level: 'error',
    })
    return null
  }
}

export type CreditBundle = {
  id: string
  credit_minor_units: number
  price_minor_units: number
  discount_minor_units: number
  local_credit_minor_units: number
  local_price_minor_units: number
}

export type BundlePricing = {
  bundles?: CreditBundle[]
  currency?: string
  stripe_product_id?: string
}

/** Bundle rJ7 — read the purchasable credit bundles (404 = none available). */
export async function getPricingBundles(): Promise<BundlePricing | null> {
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    return (
      await axios.get(
        `${baseUrl}/api/oauth/organizations/${orgUUID}/prepaid/bundles`,
        { headers, timeout: 5000 },
      )
    ).data
  } catch (error) {
    const axiosError = error as {
      isAxiosError?: boolean
      response?: { status?: number }
    }
    if (axiosError.isAxiosError && axiosError.response?.status === 404) {
      return null
    }
    logForDebugging(`getPricingBundles failed: ${String(error)}`, {
      level: 'error',
    })
    return null
  }
}

export type PaymentMethod = {
  brand?: string
  type?: string
  last4?: string
}

/** Bundle oJ7 — read the card on file (null when none). */
export async function getPaymentMethod(): Promise<PaymentMethod | null> {
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    const data = await axios.get(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/payment_method`,
      { headers, timeout: 5000 },
    )
    return data.data ?? null
  } catch (error) {
    logForDebugging(`getPaymentMethod failed: ${String(error)}`, {
      level: 'error',
    })
    return null
  }
}

export type PurchaseRequest =
  | { kind: 'bundle'; bundle: CreditBundle }
  | { kind: 'custom'; amountCents: number }

export type PurchaseResult = {
  payment_status?: 'success' | 'pending_invoice' | 'requires_action' | string
  purchase_id?: string
  payment_intent_client_secret?: string
}

/** Bundle aJ7 — purchase credits (a preset bundle or a custom amount). */
export async function purchaseCredits(
  request: PurchaseRequest,
): Promise<PurchaseResult> {
  const body =
    request.kind === 'bundle'
      ? {
          amount: request.bundle.credit_minor_units,
          bundle_id: request.bundle.id,
          expected_price_minor_units: request.bundle.price_minor_units,
        }
      : { amount: request.amountCents }
  const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
  return (
    await axios.post(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/contracts/prepaid/credits`,
      body,
      { headers },
    )
  ).data
}

/** Bundle sJ7 — preview the tax on a purchase (null when unavailable). */
export async function previewTax(
  priceMinorUnits: number,
  currency: string,
  productId?: string,
): Promise<
  | {
      tax_minor_units: number
      tax_rate_pct: number
      tax_label: string | null
    }
  | null
> {
  if (!productId) return null
  try {
    const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
    const response = await axios.post(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/billing/tax_rate`,
      { product_id: productId, price: priceMinorUnits, currency },
      { headers, timeout: 5000 },
    )
    const rate = response.data.tax_rate
    if (rate == null) return null
    return {
      tax_minor_units: Math.round((priceMinorUnits * rate) / 100),
      tax_rate_pct: rate,
      tax_label: response.data.tax_label ?? null,
    }
  } catch (error) {
    logForDebugging(`tax_rate preview unavailable: ${String(error)}`)
    return null
  }
}

/** Bundle tJ7 — poll a commit's purchase status until settled. */
export async function getPurchaseStatus(
  purchaseId: string,
): Promise<{
  status: 'paid' | 'pending' | 'failed' | 'action_needed'
  stripe_payment_intent_client_secret?: string | null
}> {
  const { headers, orgUUID, baseUrl } = await getOrgAuthContext()
  return (
    await axios.get(
      `${baseUrl}/api/oauth/organizations/${orgUUID}/prepaid/commits/${purchaseId}`,
      { headers },
    )
  ).data
}
