import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  getOAuthHeaders,
  prepareApiRequest,
} from '../../utils/teleport/api.js'

/**
 * Official 2.1.128 share sub-feature (G34). REST client for the team-onboarding
 * "share" layer: uploads the current org's ONBOARDING.md to
 * /api/organizations/{orgUUID}/claude_code/onboarding and returns a share link
 * teammates can open in Claude Code.
 */

/** Official 2.1.128 D26 — per-request timeout in milliseconds. */
const ONBOARDING_REQUEST_TIMEOUT_MS = 10_000

/** A guide entry as returned by the onboarding share listing (GET). */
export type OnboardingGuide = {
  share_url: string
  short_code: string
  updated_at: string
}

/**
 * Official 2.1.128 j26 — org scope + auth headers for a share request.
 * Reuses the tree's prepareApiRequest()/getOAuthHeaders() (the bundle's HO()/d5()),
 * plus the OAuth beta header the bundle carries via pM.
 */
async function getOnboardingRequestContext(): Promise<{
  orgUUID: string
  headers: Record<string, string>
}> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    orgUUID,
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
  }
}

/**
 * Official 2.1.128 xx7 — create a new share link for a guide.
 * POST /api/organizations/{orgUUID}/claude_code/onboarding
 * Fires the tengu_team_onboarding_share_created telemetry event on success.
 */
export async function createOnboardingGuide(
  content: string,
  name?: string,
): Promise<{ share_url: string; short_code: string }> {
  const { orgUUID, headers } = await getOnboardingRequestContext()
  const url = `${getOauthConfig().BASE_API_URL}/api/organizations/${orgUUID}/claude_code/onboarding`
  const response = await axios.post<{ share_url: string; short_code: string }>(
    url,
    { content, name },
    { headers, timeout: ONBOARDING_REQUEST_TIMEOUT_MS },
  )
  logEvent('tengu_team_onboarding_share_created', {})
  return response.data
}

/**
 * Official 2.1.128 ux7 — replace an existing guide's content.
 * PUT /api/organizations/{orgUUID}/claude_code/onboarding/{short_code}
 * Fires the tengu_team_onboarding_share_updated telemetry event on success.
 */
export async function updateOnboardingGuide(
  shortCode: string,
  content: string,
): Promise<{ share_url: string; short_code: string }> {
  const { orgUUID, headers } = await getOnboardingRequestContext()
  const url = `${getOauthConfig().BASE_API_URL}/api/organizations/${orgUUID}/claude_code/onboarding/${shortCode}`
  const response = await axios.put<{ share_url: string; short_code: string }>(
    url,
    { content },
    { headers, timeout: ONBOARDING_REQUEST_TIMEOUT_MS },
  )
  logEvent('tengu_team_onboarding_share_updated', {})
  return response.data
}

/**
 * Official 2.1.128 mx7 — list this org's onboarding guides.
 * GET /api/organizations/{orgUUID}/claude_code/onboarding
 */
export async function listOnboardingGuides(): Promise<OnboardingGuide[]> {
  const { orgUUID, headers } = await getOnboardingRequestContext()
  const url = `${getOauthConfig().BASE_API_URL}/api/organizations/${orgUUID}/claude_code/onboarding`
  const response = await axios.get<{ guides: OnboardingGuide[] }>(url, {
    headers,
    timeout: ONBOARDING_REQUEST_TIMEOUT_MS,
  })
  return response.data.guides
}

/**
 * Official 2.1.128 wu_ — the most recently updated guide for this org, or
 * undefined when the org has none yet.
 */
export async function getMostRecentOnboardingGuide(): Promise<OnboardingGuide | undefined> {
  const guides = await listOnboardingGuides()
  if (guides.length === 0) return
  return guides.reduce((latest, guide) =>
    guide.updated_at > latest.updated_at ? guide : latest,
  )
}
