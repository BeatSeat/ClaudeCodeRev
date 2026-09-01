import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import {
  getOAuthHeaders,
  prepareApiRequest,
} from '../../utils/teleport/api.js'

/**
 * Team-onboarding guide REST share layer (`/claude_code/onboarding`).
 *
 * Official 2.1.132. The REST layer (create/update/list/delete) is gated by
 * `tengu_flint_harbor_share`; this module ports that layer with the 132
 * delta being the DELETE endpoint and its `tengu_team_onboarding_share_deleted`
 * event. Auth reuses `prepareApiRequest` (bundle `xA8`) + OAuth headers
 * (bundle `b5`) with the `oauth-2025-04-20` beta header (bundle `QM`).
 */

/** Official 2.1.132 `CA8` — REST request timeout. */
const ONBOARDING_SHARE_REQUEST_TIMEOUT_MS = 10_000

/** Official 2.1.132 `QM` — anthropic-beta header for the onboarding REST. */
const ONBOARDING_SHARE_BETA = 'oauth-2025-04-20'

/**
 * Official 2.1.132 `s8H` — anthropic-client-platform header value derived
 * from CLAUDE_CODE_ENTRYPOINT.
 */
function getOnboardingShareClientPlatform(): string {
  switch (process.env.CLAUDE_CODE_ENTRYPOINT) {
    case 'claude-vscode':
      return 'claude_code_vscode'
    case 'remote':
    case 'remote_baku':
    case 'remote_desktop':
    case 'remote_mobile':
      return 'claude_code_remote'
    case 'sdk-cli':
    case 'sdk-ts':
    case 'sdk-py':
      return 'claude_code_sdk'
    case 'mcp':
      return 'claude_code_mcp'
    case 'claude-code-github-action':
      return 'claude_code_github_action'
    case 'local-agent':
      return 'claude_code_local_agent'
    case 'claude_in_slack':
      return 'claude_in_slack'
    case 'cli':
    default:
      return 'claude_code_cli'
  }
}

/**
 * Official 2.1.132 `xA8` — resolve the org UUID + the REST header set for the
 * onboarding share endpoints.
 */
async function getOnboardingShareAuth(): Promise<{
  orgUUID: string
  headers: Record<string, string>
}> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    orgUUID,
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-client-platform': getOnboardingShareClientPlatform(),
      'anthropic-beta': ONBOARDING_SHARE_BETA,
    },
  }
}

function onboardingShareBaseUrl(): string {
  return `${getOauthConfig().BASE_API_URL}/api/organizations`
}

export type SharedOnboardingGuide = {
  short_code: string
  share_url: string
  updated_at: string
  [key: string]: unknown
}

/** Official 2.1.132 `CB7` — POST /onboarding (create a shared guide). */
export async function createSharedOnboardingGuide(
  content: string,
  name: string,
): Promise<unknown> {
  const { orgUUID, headers } = await getOnboardingShareAuth()
  const url = `${onboardingShareBaseUrl()}/${orgUUID}/claude_code/onboarding`
  const response = await axios.post(url, { content, name }, {
    headers,
    timeout: ONBOARDING_SHARE_REQUEST_TIMEOUT_MS,
  })
  logEvent('tengu_team_onboarding_share_created', {})
  return response.data
}

/** Official 2.1.132 `KZ6` — PUT /onboarding/:short_code (update a guide). */
export async function updateSharedOnboardingGuide(
  shortCode: string,
  content: string,
): Promise<unknown> {
  const { orgUUID, headers } = await getOnboardingShareAuth()
  const url = `${onboardingShareBaseUrl()}/${orgUUID}/claude_code/onboarding/${encodeURIComponent(shortCode)}`
  const response = await axios.put(url, { content }, {
    headers,
    timeout: ONBOARDING_SHARE_REQUEST_TIMEOUT_MS,
  })
  logEvent('tengu_team_onboarding_share_updated', {})
  return response.data
}

/**
 * Official 2.1.132 `bB7` — DELETE /onboarding/:short_code. The 2.1.132 delta
 * of the onboarding share REST layer: removes a shared guide and emits
 * `tengu_team_onboarding_share_deleted`.
 */
export async function deleteSharedOnboardingGuide(
  shortCode: string,
): Promise<void> {
  const { orgUUID, headers } = await getOnboardingShareAuth()
  const url = `${onboardingShareBaseUrl()}/${orgUUID}/claude_code/onboarding/${encodeURIComponent(shortCode)}`
  await axios.delete(url, {
    headers,
    timeout: ONBOARDING_SHARE_REQUEST_TIMEOUT_MS,
  })
  logEvent('tengu_team_onboarding_share_deleted', {})
}

/** Official 2.1.132 `_Z6` — GET /onboarding (list the org's shared guides). */
export async function listSharedOnboardingGuides(): Promise<
  SharedOnboardingGuide[]
> {
  const { orgUUID, headers } = await getOnboardingShareAuth()
  const url = `${onboardingShareBaseUrl()}/${orgUUID}/claude_code/onboarding`
  const response = await axios.get(url, {
    headers,
    timeout: ONBOARDING_SHARE_REQUEST_TIMEOUT_MS,
  })
  return response.data.guides
}

/**
 * Official 2.1.132 `bA8` — gate for the onboarding share layer: disabled when
 * traffic is essential-only, when there is no Claude.ai access token, or when
 * `tengu_flint_harbor_share` is off.
 */
export function isTeamOnboardingShareEnabled(): boolean {
  // bundle bA8: essential-traffic only → off; no Claude.ai token → off.
  if (isEssentialTrafficOnly()) {
    return false
  }
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_flint_harbor_share', false)
}
