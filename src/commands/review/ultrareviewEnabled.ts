import { getIsRemoteMode } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { CLAUDE_AI_INFERENCE_SCOPE } from '../../constants/oauth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProvider } from '../../utils/model/providers.js'

function isRemoteSession(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode()
}

function isFirstPartyProvider(): boolean {
  return getAPIProvider() === 'firstParty'
}

function hasInferenceScope(): boolean {
  try {
    return Boolean(
      getClaudeAIOAuthTokens()?.scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE),
    )
  } catch {
    return false
  }
}

function isSubscriberSafe(): boolean {
  try {
    return isClaudeAISubscriber()
  } catch {
    return false
  }
}

function hasProfileScopeSafe(): boolean {
  try {
    return hasProfileScope()
  } catch {
    return false
  }
}

/** Official 2.1.172 `WCH`. */
function getUltrareviewConfig(): Record<string, unknown> | null {
  return getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
}

/**
 * Official 2.1.172 `PCH` — firstParty + subscriber + `tengu_ccr_bridge`.
 * Shared with Remote Control entitlement.
 */
function isCloudReviewEntitled(): boolean {
  return (
    isFirstPartyProvider() &&
    isSubscriberSafe() &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
  )
}

/** Official 2.1.172 `Ad6`. */
function getUltrareviewEntitlementReason():
  | null
  | 'not_signed_in'
  | 'api_key_auth'
  | 'no_profile_scope'
  | 'not_in_rollout' {
  if (isCloudReviewEntitled()) return null
  if (!hasInferenceScope()) return 'not_signed_in'
  if (!isSubscriberSafe()) return 'api_key_auth'
  if (!hasProfileScopeSafe()) return 'no_profile_scope'
  return 'not_in_rollout'
}

/** Official 2.1.172 `ehH`. */
function hintForAuthSource(source: string): string {
  switch (source) {
    case 'claude.ai':
      return 'claude /logout to sign out of claude.ai.'
    case 'profile':
      return 'Run `ant auth logout`, or remove the active profile under ~/.config/anthropic/configs/.'
    case 'apiKeyHelper':
      return 'Unset the apiKeyHelper setting.'
    case 'CCR_OAUTH_TOKEN_FILE':
      return 'This token is injected by the CCR host; check the host session.'
    case 'none':
      return ''
    default:
      return `Unset the ${source} environment variable.`
  }
}

/** Official 2.1.172 `_28`. */
function formatApiKeyAuthRequirement({
  prefix,
  suffix,
}: {
  prefix: string
  suffix: string
}): string {
  try {
    const { source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (source === 'ANTHROPIC_API_KEY') {
      return `${prefix} ANTHROPIC_API_KEY is set, so this session is using API-key auth \u2014 unset it (or run in a shell without it) ${suffix}`
    }
    if (source === 'apiKeyHelper') {
      return `${prefix} apiKeyHelper is configured, so this session is using API-key auth \u2014 unset it ${suffix}`
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      return `${prefix} ANTHROPIC_AUTH_TOKEN is set, so this session is using API-key auth \u2014 unset it (or run in a shell without it) ${suffix}`
    }
    const { source: tokenSource } = getAuthTokenSource()
    const hint = hintForAuthSource(tokenSource)
    if (tokenSource !== 'none' && hint) {
      return `${prefix} This session is using ${tokenSource} auth \u2014 ${hint}`
    }
    if (process.env.ANTHROPIC_UNIX_SOCKET) {
      return `${prefix} ANTHROPIC_UNIX_SOCKET is set (claude ssh remote), and the local proxy is API-key-authed.`
    }
  } catch {
    // fall through
  }
  return `${prefix} Unset ANTHROPIC_API_KEY / apiKeyHelper / ANTHROPIC_AUTH_TOKEN ${suffix}`
}

/**
 * Runtime gate for /ultrareview. GB config's `enabled` field controls
 * visibility — isEnabled() on the command filters it from getCommands()
 * when false, so ungated users don't see the command at all.
 */
export function isUltrareviewEnabled(): boolean {
  return getUltrareviewConfig()?.enabled === true
}

/** Official 2.1.172 `i$$` — feature on (GB + firstParty + not remote). */
export function isUltrareviewFeatureEnabled(): boolean {
  return isUltrareviewEnabled() && isFirstPartyProvider() && !isRemoteSession()
}

/** Official 2.1.172 `hQ` — signed-in entitled cloud review. */
export function isUltrareviewCloudEntitled(): boolean {
  return isUltrareviewFeatureEnabled() && isCloudReviewEntitled()
}

/** Official 2.1.172 `z28`. */
export function getUltrareviewUnavailableReason(): string | null {
  if (!isUltrareviewFeatureEnabled() || isUltrareviewCloudEntitled()) {
    return null
  }
  switch (getUltrareviewEntitlementReason()) {
    case 'api_key_auth':
      return `${formatApiKeyAuthRequirement({ prefix: 'ultra (cloud review) requires claude.ai account auth.', suffix: 'to use ultra.' })} See https://code.claude.com/docs/en/ultrareview.`
    case 'no_profile_scope': {
      const { source } = getAuthTokenSource()
      if (source === 'CLAUDE_CODE_OAUTH_TOKEN') {
        return `ultra (cloud review) requires a full-scope login token. ${hintForAuthSource(source)} Then run \`claude auth login\` to use it; see https://code.claude.com/docs/en/ultrareview.`
      }
      return 'ultra (cloud review) requires a full-scope login token \u2014 run `claude auth login` to use it; see https://code.claude.com/docs/en/ultrareview.'
    }
    case 'not_in_rollout':
      return "ultra (cloud review) isn't enabled for your account yet \u2014 run `claude auth login` to refresh your entitlements; see https://code.claude.com/docs/en/ultrareview."
    default:
      return 'ultra (cloud review) requires a claude.ai account \u2014 sign in to claude.ai to use it; see https://code.claude.com/docs/en/ultrareview.'
  }
}
