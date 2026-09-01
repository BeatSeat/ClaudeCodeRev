import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { toCompatSessionId } from '../../bridge/sessionIdCompat.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

const ANTHROPIC_VERSION = '2023-06-01'
const CCR_BYOC_BETA = 'ccr-byoc-2025-07-29'

function githubPrHeaders(
  accessToken: string,
  organizationUuid?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': CCR_BYOC_BETA,
  }
  if (organizationUuid !== undefined) {
    headers['x-organization-uuid'] = organizationUuid
  }
  return headers
}

function axiosDataMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return
  if ('message' in data && typeof data.message === 'string') return data.message
  if (
    'error' in data &&
    data.error !== null &&
    typeof data.error === 'object' &&
    'message' in data.error &&
    typeof data.error.message === 'string'
  ) {
    return data.error.message
  }
  return
}

/**
 * Official 2.1.94 AEK: POST /v1/code/github/${action}-pr.
 * 2xx and 409 are success; 4xx otherwise and 5xx/network fail.
 */
export async function postGithubPrAction(
  action: 'subscribe',
  sessionId: string,
  repo: string,
  prNumber: number,
  baseApiUrl: string,
  getAccessToken: () => string | undefined,
): Promise<boolean> {
  const accessToken = getAccessToken()
  if (!accessToken) {
    logForDebugging(`[bridge] No access token for ${action}-pr`)
    return false
  }
  const url = `${baseApiUrl}/v1/code/github/subscribe-pr`
  const body = {
    session_id: toCompatSessionId(sessionId),
    repo,
    pr_number: prNumber,
  }
  let response
  try {
    response = await axios.post(url, body, {
      headers: githubPrHeaders(accessToken),
      timeout: 10_000,
      validateStatus: status => status < 500,
    })
  } catch (error) {
    logForDebugging(
      `[bridge] ${action}-pr request failed: ${errorMessage(error)}`,
    )
    return false
  }
  if (
    !(
      (response.status >= 200 && response.status < 300) ||
      response.status === 409
    )
  ) {
    const detail = axiosDataMessage(response.data)
    logForDebugging(
      `[bridge] ${action}-pr failed ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return false
  }
  logForDebugging(`[bridge] ${action}-pr ${repo}#${prNumber} ok`)
  return true
}

export async function githubPrSubscribe(
  sessionId: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  return postGithubPrAction(
    'subscribe',
    sessionId,
    repo,
    prNumber,
    getOauthConfig().BASE_API_URL,
    () => getClaudeAIOAuthTokens()?.accessToken,
  )
}
