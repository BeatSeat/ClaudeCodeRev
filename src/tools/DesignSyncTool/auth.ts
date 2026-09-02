import { mkdir } from 'fs/promises'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import {
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
} from '../../services/oauth/client.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  getClaudeAIOAuthTokensAsync,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import * as lockfile from '../../utils/lockfile.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { sleep } from '../../utils/sleep.js'
import { DESIGN_READ_SCOPE, DESIGN_WRITE_SCOPE } from './constants.js'

export type DesignAuthReason =
  | 'wrong_provider'
  | 'essential_traffic_only'
  | 'no_token'
  | 'no_refresh'
  | 'expand_failed'

export type DesignAuthResult =
  | { ok: true; accessToken: string; expanded: boolean }
  | { ok: false; reason: DesignAuthReason; detail?: string }

/** Official 2.1.160 `x08`. */
export function isDesignSyncEnabled(): boolean {
  if (!isPolicyAllowed('allow_design_sync')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_quill', false)
}

/** Official 2.1.160 `u08`. */
export function hasDesignScopes(scopes: string[] | undefined): boolean {
  return !!scopes && scopes.includes(DESIGN_READ_SCOPE) && scopes.includes(DESIGN_WRITE_SCOPE)
}

/** Official 2.1.160 `NJ4` — missing design scopes on the claude.ai login. */
export function needsDesignScopeExpansion(): boolean {
  if (getAPIProvider() !== 'firstParty' || isEssentialTrafficOnly()) {
    return false
  }
  const tokens = getClaudeAIOAuthTokens()
  return (
    !!tokens?.accessToken &&
    !!tokens.refreshToken &&
    !hasDesignScopes(tokens.scopes)
  )
}

/** Official 2.1.160 `ic5`. */
export function designAuthHint(reason: DesignAuthReason): string {
  switch (reason) {
    case 'no_token':
      return 'Run /login to sign in to claude.ai, then retry.'
    case 'no_refresh':
      return 'The OAuth token was supplied via CLAUDE_CODE_OAUTH_TOKEN and cannot be expanded with design scopes. Run /login in this session.'
    case 'expand_failed':
      return 'Could not add design scopes to the token. Run /login and retry.'
    case 'wrong_provider':
      return 'DesignSync is only available with claude.ai authentication. It is not supported through Bedrock, Vertex, or other third-party providers.'
    case 'essential_traffic_only':
      return 'DesignSync is unavailable while nonessential network traffic is restricted (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set). Unset it to use /design-sync.'
  }
}

const MAX_LOCK_RETRIES = 5

/**
 * Official 2.1.160 `kJ4` — refresh under the same lock as `t36` so scope
 * expansion persists (`OwH` / `saveOAuthTokensIfNeeded`).
 */
export async function ensureDesignAccess(): Promise<DesignAuthResult> {
  if (getAPIProvider() !== 'firstParty') {
    return { ok: false, reason: 'wrong_provider' }
  }
  if (isEssentialTrafficOnly()) {
    return { ok: false, reason: 'essential_traffic_only' }
  }
  await checkAndRefreshOAuthTokenIfNeeded()
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    return { ok: false, reason: 'no_token' }
  }
  if (hasDesignScopes(tokens.scopes)) {
    return { ok: true, accessToken: tokens.accessToken, expanded: false }
  }
  if (!tokens.refreshToken) {
    return { ok: false, reason: 'no_refresh' }
  }
  try {
    return await withOAuthRefreshLock(async locked => {
      if (!locked?.refreshToken) {
        return { ok: false, reason: 'no_refresh' }
      }
      if (hasDesignScopes(locked.scopes) && locked.accessToken) {
        return { ok: true, accessToken: locked.accessToken, expanded: false }
      }
      const refreshed = await refreshOAuthToken(locked.refreshToken, {
        scopes: shouldUseClaudeAIAuth(locked.scopes)
          ? undefined
          : locked.scopes,
      })
      await saveOAuthTokensIfNeeded(refreshed)
      if (!hasDesignScopes(refreshed.scopes)) {
        return {
          ok: false,
          reason: 'expand_failed',
          detail: 'refresh succeeded but design scopes not granted',
        }
      }
      return { ok: true, accessToken: refreshed.accessToken, expanded: true }
    })
  } catch (err) {
    return { ok: false, reason: 'expand_failed', detail: errorMessage(err) }
  }
}

/** Official 2.1.160 `oc5`. */
export async function requireDesignAccess(): Promise<{
  accessToken: string
  expanded: boolean
}> {
  const result = await ensureDesignAccess()
  if (result.ok === true) {
    return { accessToken: result.accessToken, expanded: result.expanded }
  }
  const prefix =
    result.reason === 'wrong_provider' ||
    result.reason === 'essential_traffic_only'
      ? ''
      : 'DesignSync needs a claude.ai login. '
  const detail = result.detail ? ` (${result.detail})` : ''
  throw new Error(`${prefix}${designAuthHint(result.reason)}${detail}`)
}

async function withOAuthRefreshLock<T>(
  fn: (lockedTokens: ReturnType<typeof getClaudeAIOAuthTokens>) => Promise<T>,
): Promise<T> {
  const claudeDir = getClaudeConfigHomeDir()
  await mkdir(claudeDir, { recursive: true })
  let release: (() => Promise<void>) | undefined
  let attempts = 0
  while (!release) {
    attempts++
    try {
      release = await lockfile.lock(claudeDir)
    } catch (err) {
      if ((err as { code?: string }).code === 'ELOCKED') {
        if (attempts < MAX_LOCK_RETRIES) {
          await sleep(1000 + Math.random() * 1000)
          continue
        }
        throw new Error(
          `Lock acquisition failed after ${attempts} attempts: another process is refreshing`,
        )
      }
      throw err
    }
  }
  try {
    getClaudeAIOAuthTokens.cache?.clear?.()
    const lockedTokens = await getClaudeAIOAuthTokensAsync()
    return await fn(lockedTokens)
  } finally {
    try {
      await release()
    } catch {
      // official t36 swallows unlock errors
    }
  }
}
