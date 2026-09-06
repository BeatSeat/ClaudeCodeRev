/**
 * Official 2.1.178 Fable plan-credit / extra-usage helpers.
 * `ScK` `n58` `Cy_` `OzH` `LQ` `GE` `cEH` `by_` `i58` `x39` `HH6`/`G3$`.
 */
import {
  getOauthAccountInfo,
  getRateLimitTier,
  isClaudeAISubscriber,
  isEnterpriseUsageBasedSubscriber,
} from '../auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getDefaultFableModel, isFableAvailable } from './model.js'
import { getAPIProvider } from './providers.js'

export type Fable5LaunchConfig = {
  enabled?: boolean
  planLimitsEndDate?: string
  hideRateLimitsDescription?: boolean
  overageConsentRequired?: boolean
}

const DEFAULT_LAUNCH: Fable5LaunchConfig = { enabled: false }

let launchCache: { raw: unknown; parsed: Fable5LaunchConfig } | null = null
let planLimitsEndCache: { value: string; ms: number } | null = null

/** Official 2.1.178 `HH6` / `G3$` — session flag (p$ on official; Core owns bootstrap). */
let fableCreditsRequired = false
/** Official 2.1.178 `ol$` / `_H6`. */
let fableConsentSessionFallback = false

/**
 * Official 2.1.178 `ScK` — normalize `YYYY-MM-DD HH:MM` → `T` and assume UTC
 * when the string has a time but no zone.
 */
export function parseLatticeDate(raw: string): number {
  const withT = raw.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d{2}:)/, '$1T')
  const hasTime = withT.includes('T')
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withT)
  return Date.parse(hasTime && !hasZone ? `${withT}Z` : withT)
}

/** Official 2.1.178 `n58` (176 `SKf`). */
export function formatPlanLimitsEndDate(
  iso: string | undefined,
): string | undefined {
  if (!iso) return
  const parsed = parseLatticeDate(iso)
  if (Number.isNaN(parsed)) return
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/** Official 2.1.178 `Cy_`. */
export function isPlanLimitsEndDatePassed(
  iso: string | undefined,
): boolean {
  if (iso === undefined) return false
  if (planLimitsEndCache === null || planLimitsEndCache.value !== iso) {
    planLimitsEndCache = { value: iso, ms: parseLatticeDate(iso) }
  }
  return Date.now() >= planLimitsEndCache.ms
}

function parseLaunchConfig(raw: unknown): Fable5LaunchConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_LAUNCH
  const o = raw as Record<string, unknown>
  const parsed: Fable5LaunchConfig = {}
  if (typeof o.enabled === 'boolean') parsed.enabled = o.enabled
  if (typeof o.planLimitsEndDate === 'string') {
    parsed.planLimitsEndDate = o.planLimitsEndDate
  }
  if (typeof o.hideRateLimitsDescription === 'boolean') {
    parsed.hideRateLimitsDescription = o.hideRateLimitsDescription
  }
  if (typeof o.overageConsentRequired === 'boolean') {
    parsed.overageConsentRequired = o.overageConsentRequired
  }
  return parsed
}

/** Official 2.1.178 `OzH` / `qp` schema (`tengu_saffron_lattice`). */
export function getFable5LaunchConfig(): Fable5LaunchConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_saffron_lattice',
    DEFAULT_LAUNCH,
  )
  if (launchCache === null || launchCache.raw !== raw) {
    launchCache = { raw, parsed: parseLaunchConfig(raw) }
  }
  return launchCache.parsed
}

/** Official 2.1.178 `HH6`. */
export function getFableCreditsRequired(): boolean {
  return fableCreditsRequired
}

/** Official 2.1.178 `G3$`. */
export function setFableCreditsRequired(value: boolean): void {
  fableCreditsRequired = value
}

/** Official 2.1.178 `ol$`. */
export function getFableConsentSessionFallback(): boolean {
  return fableConsentSessionFallback
}

/** Official 2.1.178 `_H6`. */
export function setFableConsentSessionFallback(value: boolean): void {
  fableConsentSessionFallback = value
}

/**
 * Official 2.1.178 `LQ` — promo/overage window is over (consent required,
 * plan-limits date passed, or a Fable credits 429 this session).
 */
export function isFableOverageRequired(): boolean {
  const launch = getFable5LaunchConfig()
  return (
    launch.overageConsentRequired === true ||
    isPlanLimitsEndDatePassed(launch.planLimitsEndDate) ||
    getFableCreditsRequired()
  )
}

/**
 * Official 2.1.178 `GE` — hide plan-limits copy (not first-party, not a
 * claude.ai subscriber, enterprise usage-based, or `default_claude_zero`).
 */
export function isFablePermanentAccess(): boolean {
  return (
    getAPIProvider() !== 'firstParty' ||
    !isClaudeAISubscriber() ||
    isEnterpriseUsageBasedSubscriber() ||
    getRateLimitTier() === 'default_claude_zero'
  )
}

/** Official 2.1.178 `RcK`. */
export function getFableOverageConsentKey(): string | null {
  const account = getOauthAccountInfo()
  if (!account) return null
  if (account.organizationUuid) return account.organizationUuid
  return account.accountUuid ? `acct:${account.accountUuid}` : null
}

/** Official 2.1.178 `cEH`. */
export function hasFableOverageConsent(): boolean {
  if (getFableOverageConsentKey() === null) {
    return getFableConsentSessionFallback()
  }
  const account = getOauthAccountInfo()
  if (!account) return getFableConsentSessionFallback()
  const consent = getGlobalConfig().fableOverageConsent
  return (
    (account.organizationUuid !== undefined &&
      consent?.[account.organizationUuid] === true) ||
    (account.accountUuid !== undefined &&
      consent?.[`acct:${account.accountUuid}`] === true)
  )
}

/** Official 2.1.178 `by_`. */
export function persistFableOverageConsent(key: string): void {
  if (getGlobalConfig().fableOverageConsent?.[key] === true) return
  saveGlobalConfig(current => ({
    ...current,
    fableOverageConsent: { ...current.fableOverageConsent, [key]: true },
  }))
}

/** Official 2.1.178 `i58`. */
export function recordFableOverageConsent(): void {
  const key = getFableOverageConsentKey()
  if (key === null) {
    setFableConsentSessionFallback(true)
    return
  }
  persistFableOverageConsent(key)
}

/** Official 2.1.178 `xg8`. */
function shouldShowFable5Notice(): boolean {
  if (getAPIProvider() !== 'firstParty') return false
  if (!isFableAvailable()) return false
  if (!isModelAllowed(getDefaultFableModel())) return false
  return getFable5LaunchConfig().enabled !== false
}

/**
 * Official 2.1.178 `x39` (176 `eD4`) — `fable5LaunchShow` snapshot.
 * Adds `promoOver` (`LQ`) and `permanentAccess` (`GE`).
 */
export function getFable5LaunchShowSnapshot(): string | false {
  if (!shouldShowFable5Notice()) return false
  return JSON.stringify({
    planLimitsEndDate: getFable5LaunchConfig().planLimitsEndDate,
    isFirstParty: getAPIProvider() === 'firstParty',
    promoOver: isFableOverageRequired(),
    permanentAccess: isFablePermanentAccess(),
  })
}
