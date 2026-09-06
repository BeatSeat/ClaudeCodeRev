/**
 * Official 2.1.172 (G2 — tengu_cobalt_plinth / tengu_cobalt_plinth_direct):
 * the artifact-publish upload engine + the WebFetch artifact-read path.
 *
 * These are the "upload/size-cap helpers" half of the G2 net-new block.
 * Minified → readable map:
 *   e24 → publishArtifact        (two-phase: /api/frame/deploy/init → PUT → /complete)
 *   s24 → directPublishArtifact  (/api/frame/deploy/direct, entrypoint-gated)
 *   a24 → completeDeploy         (/api/frame/deploy/complete, fire-and-forget)
 *   t24 → buildDeployPayload     (slug/title/favicon/label → request body)
 *   S4f → uploadToPutUrl         (PUT the rendered HTML to the signed putURL)
 *   E4f → notePutUrlSeen         (LRU touch for the create-only 412 dedupe)
 *   HZ4 → buildArtifactUrl       (slug → public claude.ai/code/artifact URL)
 *   oi  → artifactError          ({url:null,slug:null,version:null,err})
 *   xK$ → truncateErrorBody      (first 200 chars of a server error body)
 *   R4f → readArtifactContent    (WebFetch: boot /api/frame/{slug} + fetch asset)
 *
 * Constants:
 *   NYH → MAX_ARTIFACT_BYTES  (16 MiB page cap)
 *   N4f → DIRECT_UPLOAD_ENTRYPOINTS  ({"remote","remote_cowork"})
 *   y4f → PAGE_SHELL_STYLE  (the inlined <style> injected into every page)
 *   bK$/h4f → putUrlSeen / PUT_URL_LRU_SIZE (412 create-only dedupe)
 *
 * Gate wiring: the direct-upload path is taken when the entrypoint is in
 * DIRECT_UPLOAD_ENTRYPOINTS, or CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD is set, or
 * the entrypoint is remote* AND the tengu_cobalt_plinth_direct gate (default
 * false) is on. Everything is gated upstream by isArtifactToolEnabled().
 */

import axios, { type AxiosResponse } from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { refreshOAuthToken } from '../../services/oauth/client.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../../services/analytics/growthbook.js'
import { getAPIProvider } from '../../utils/model/providers.js'

// `NYH` — 16 MiB. Both the rendered-page size cap and the maxBodyLength/
// maxContentLength on the upload + read paths.
export const MAX_ARTIFACT_BYTES = 16777216

// `N4f` — entrypoints that always take the direct-upload path.
const DIRECT_UPLOAD_ENTRYPOINTS = new Set(['remote', 'remote_cowork'])

// `y4f` — the <style> shell inlined into every rendered page.
const PAGE_SHELL_STYLE =
  '<style>:root{color-scheme:light}body{margin:0;padding:20px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}</style>'

// `h4f` — LRU size for the create-only 412 dedupe.
const PUT_URL_LRU_SIZE = 64

// `bK$` — insertion-ordered Set used as a tiny LRU of seen putURLs.
const putUrlSeen = new Set<string>()

/**
 * `E4f` — mark a putURL as seen, evicting the oldest once past the cap. A
 * second PUT to the same URL within a session is then a no-op (the 412
 * "already written" precondition is swallowed), so a mid-flight retry does not
 * surface a spurious upload error.
 */
function notePutUrlSeen(putUrl: string): void {
  putUrlSeen.delete(putUrl)
  putUrlSeen.add(putUrl)
  if (putUrlSeen.size > PUT_URL_LRU_SIZE) {
    const oldest = putUrlSeen.values().next().value
    if (oldest !== undefined) {
      putUrlSeen.delete(oldest)
    }
  }
}

// ---------------------------------------------------------------------------
// Telemetry wrappers — the bundle's `SH`/`bH`/`e$` (tengu_feature_ok/bad/sad).
// ---------------------------------------------------------------------------

function logFeatureOk(featureName: string): void {
  logEvent('tengu_feature_ok', {
    feature_name: featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function logFeatureBad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_bad', {
    feature_name: featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code: errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function logFeatureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code: errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

// ---------------------------------------------------------------------------
// `xK$` — first 200 chars of a server error body (string or object).
// ---------------------------------------------------------------------------

function truncateErrorBody(body: unknown): string {
  if (typeof body === 'string') {
    return body.slice(0, 200)
  }
  if (body && typeof body === 'object') {
    return (JSON.stringify(body) ?? '').slice(0, 200)
  }
  return ''
}

// ---------------------------------------------------------------------------
// Authenticated first-party frame client (bundle `k7` / `sJ$`).
//
// Mirrors the subset of the bundle's firstParty client the artifact endpoints
// use: `auth:"required"` + `refreshOAuth:true`, host "api" (BASE_API_URL). The
// contract is { ok, reason?, detail?, data?, status?, response? } where `ok` is
// false for auth/traffic/residency preconditions and true otherwise (with the
// raw HTTP status, even for 4xx/5xx, via validateStatus:()=>!0).
// ---------------------------------------------------------------------------

type FrameRequestOptions = {
  timeout?: number
  headers?: Record<string, string>
  data?: unknown
  signal?: AbortSignal
  responseType?: 'json' | 'arraybuffer'
  maxContentLength?: number
  maxBodyLength?: number
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
}

type FrameResponse = {
  ok: boolean
  reason?: 'essential-traffic-only' | 'data-residency' | 'no-auth'
  detail?: string
  data?: unknown
  status?: number
  response?: AxiosResponse
}

async function refreshFrameTokenBestEffort(): Promise<void> {
  const tokens = getClaudeAIOAuthTokens()
  const refreshToken = tokens?.refreshToken
  if (!refreshToken) return
  try {
    await refreshOAuthToken(refreshToken)
  } catch (error) {
    logForDebugging(
      `firstPartyApi: refreshOAuth failed (${
        error instanceof Error ? error.message : String(error)
      }); proceeding with cached token`,
    )
  }
}

async function firstPartyFrameRequest(
  method: FrameRequestOptions['method'],
  url: string,
  options: FrameRequestOptions = {},
): Promise<FrameResponse> {
  if (isEssentialTrafficOnly()) {
    return { ok: false, reason: 'essential-traffic-only' }
  }
  if (getAPIProvider() !== 'firstParty') {
    return { ok: false, reason: 'data-residency' }
  }
  // `refreshOAuth:true` — best-effort refresh before authing the request.
  await refreshFrameTokenBestEffort()
  const tokens = getClaudeAIOAuthTokens()
  const accessToken = tokens?.accessToken
  if (!accessToken) {
    return {
      ok: false,
      reason: 'no-auth',
      detail: 'No OAuth token available',
    }
  }
  try {
    const response = await axios.request({
      method,
      url: `${getOauthConfig().BASE_API_URL}${url}`,
      data: options.data,
      timeout: options.timeout ?? 15000,
      signal: options.signal,
      responseType: options.responseType,
      maxContentLength: options.maxContentLength,
      maxBodyLength: options.maxBodyLength,
      validateStatus: () => true,
      headers: {
        'User-Agent': getWebFetchUserAgent(),
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...options.headers,
      },
    })
    return { ok: true, data: response.data, status: response.status, response }
  } catch (error) {
    return {
      ok: false,
      reason: 'no-auth',
      detail:
        error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * `HZ4` — build the public artifact page URL for a slug on CLAUDE_AI_ORIGIN.
 */
function buildArtifactUrl(slug: string): string {
  return new URL(`/code/artifact/${slug}`, getOauthConfig().CLAUDE_AI_ORIGIN).toString()
}

// ---------------------------------------------------------------------------
// Publish result shape (shared by the two-phase and direct paths).
// ---------------------------------------------------------------------------

export type PublishResult = {
  url: string | null
  slug: string | null
  version: string | null
  err: string | null
  mcpDropped?: string
}

/** `oi` — a failed publish result. */
function artifactError(err: string): PublishResult {
  return { url: null, slug: null, version: null, err }
}

// `t24` — project {slug,title,favicon,label} into the deploy request body,
// dropping undefined optional fields.
function buildDeployPayload(z: {
  slug?: string
  title?: string
  favicon?: string
  label?: string
}): Record<string, unknown> {
  return {
    ...(z.slug && { slug: z.slug }),
    title: z.title,
    favicon: z.favicon,
    ...(z.label && { label: z.label }),
  }
}

type PutHeaders = Record<string, string> | null | undefined

/**
 * `S4f` — PUT the rendered HTML to the signed putURL. Returns null on success;
 * a 412 create-only precondition is swallowed on the second call for the same
 * URL (via the putUrlSeen LRU) and otherwise reported.
 */
async function uploadToPutUrl(
  putUrl: string,
  html: string,
  maxBytes: number,
  putHeaders: PutHeaders,
): Promise<{ status: number; err: string; precondition: boolean } | null> {
  const headers =
    putHeaders && Object.keys(putHeaders).length > 0
      ? putHeaders
      : {
          'Content-Type': 'text/html; charset=utf-8',
          'x-goog-content-length-range': `0,${maxBytes}`,
          'Cache-Control': 'public, max-age=31536000, immutable',
        }
  const wasSeen = putUrlSeen.has(putUrl)
  const response = await axios.put(putUrl, html, {
    headers,
    validateStatus: () => true,
    timeout: 30000,
    maxBodyLength: maxBytes + 4096,
  })
  notePutUrlSeen(putUrl)
  if (response.status === 412) {
    if (wasSeen) return null
    return {
      status: 412,
      err: 'upload 412: this version was already written (create-only precondition). Re-run publish to mint a fresh version.',
      precondition: true,
    }
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: response.status,
      err: `upload ${response.status}: ${truncateErrorBody(response.data)}`,
      precondition: false,
    }
  }
  return null
}

/**
 * `a24` — fire-and-forget /api/frame/deploy/complete. Logs but never throws;
 * `ok` is the success flag for the version we just uploaded.
 */
async function completeDeploy(
  slug: string,
  version: string,
  ok: boolean,
): Promise<void> {
  try {
    const response = await firstPartyFrameRequest('POST', '/api/frame/deploy/complete', {
      data: { slug, version, ok },
      timeout: 15000,
      headers: { 'X-Frame-CP': 'go' },
    })
    if (!response.ok) {
      logForDebugging(`[artifact] deploy/complete skipped: ${response.reason}`)
    } else if (response.status !== 204) {
      logForDebugging(
        `[artifact] deploy/complete ${response.status}: ${truncateErrorBody(response.data)}`,
      )
    }
  } catch (error) {
    logForDebugging(
      `[artifact] deploy/complete failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * `s24` — the direct-upload path (POST /api/frame/deploy/direct). Used when the
 * entrypoint is remote/remote_cowork, CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD is set,
 * or (for remote* entrypoints) the tengu_cobalt_plinth_direct gate is on. On a
 * 400 with an mcp payload it retries once without mcp, recording the dropped
 * mcp summary as mcpDropped.
 */
async function directPublishArtifact(
  html: string,
  meta: { slug?: string; title?: string; favicon?: string; label?: string },
  mcp?: string,
  mcpDropped: string | undefined = undefined,
): Promise<PublishResult> {
  try {
    const post = (withMcp: boolean) =>
      firstPartyFrameRequest('POST', '/api/frame/deploy/direct', {
        data: { ...buildDeployPayload(meta), ...(withMcp && mcp ? { mcp } : {}), content: html },
        timeout: 60000,
        headers: { 'X-Frame-CP': 'go' },
        maxBodyLength: 2 * MAX_ARTIFACT_BYTES,
      })
    let response = await post(true)
    if (!response.ok) {
      logFeatureBad('artifact_publish', response.reason ?? 'request_error')
      return artifactError(
        response.reason === 'no-auth'
          ? `not authenticated — run /login (${response.detail})`
          : `publish unavailable: ${response.reason}`,
      )
    }
    let dropped = mcpDropped
    if (response.status === 400 && mcp) {
      if (
        (dropped = truncateErrorBody(response.data) || '(400, no body)'),
        logForDebugging(`[artifact] deploy 400 with mcp, retrying without: ${dropped}`),
        (response = await post(false)),
        !response.ok
      ) {
        logFeatureBad('artifact_publish', response.reason ?? 'request_error')
        return artifactError(`publish unavailable: ${response.reason}`)
      }
    }
    if (response.status < 200 || response.status >= 300) {
      logFeatureBad('artifact_publish', 'deploy_failed')
      return artifactError(`deploy ${response.status}: ${truncateErrorBody(response.data)}`)
    }
    const { slug, version } = (response.data ?? {}) as { slug?: string; version?: string }
    if (!slug || !version) {
      logFeatureBad('artifact_publish', 'deploy_incomplete')
      return artifactError('deploy returned incomplete response')
    }
    if (dropped !== undefined) {
      logFeatureSad('artifact_publish', 'mcp_rejected')
    }
    logFeatureOk('artifact_publish')
    return {
      url: buildArtifactUrl(slug),
      slug,
      version,
      err: null,
      ...(dropped !== undefined && { mcpDropped: dropped }),
    }
  } catch (error) {
    logFeatureBad('artifact_publish', 'request_error')
    return artifactError(error instanceof Error ? error.message : String(error))
  }
}

export type PublishInput = {
  slug?: string
  title?: string
  favicon?: string
  label?: string
  mcp?: string
}

/**
 * `e24` — the two-phase publish (default path). Renders the page shell, enforces
 * the 16 MiB cap, then either goes direct (see directPublishArtifact) or
 * POST /api/frame/deploy/init → PUT the signed putURL → /api/frame/deploy/complete.
 * A 400-with-mcp init retries once without mcp; a blocked (403) PUT falls back
 * to the direct path.
 */
export async function publishArtifact(
  html: string,
  input: PublishInput,
): Promise<PublishResult> {
  const { slug, title, favicon, label, mcp } = input
  const meta = { slug, title, favicon, label }
  const rendered = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">${PAGE_SHELL_STYLE}</head><body>\n${html}\n</body></html>`
  const renderedBytes = Buffer.byteLength(rendered, 'utf8')
  if (renderedBytes > MAX_ARTIFACT_BYTES) {
    logFeatureBad('artifact_publish', 'too_large')
    return artifactError(
      `too large: rendered page is ${Math.ceil(renderedBytes / 1024 / 1024)}MB (max ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB)`,
    )
  }

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? ''
  const isRemote = entrypoint === 'remote' || entrypoint.startsWith('remote_')
  if (
    DIRECT_UPLOAD_ENTRYPOINTS.has(entrypoint) ||
    process.env.CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD ||
    (isRemote && getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_plinth_direct', false))
  ) {
    return directPublishArtifact(rendered, meta, mcp)
  }

  try {
    const init = (withMcp: boolean) =>
      firstPartyFrameRequest('POST', '/api/frame/deploy/init', {
        data: { ...buildDeployPayload(meta), ...(withMcp && mcp ? { mcp } : {}) },
        timeout: 15000,
        headers: { 'X-Frame-CP': 'go' },
      })
    let response = await init(true)
    if (!response.ok) {
      logFeatureBad('artifact_publish', response.reason ?? 'request_error')
      return artifactError(
        response.reason === 'no-auth'
          ? `not authenticated — run /login (${response.detail})`
          : `publish unavailable: ${response.reason}`,
      )
    }
    let mcpDropped: string | undefined
    if (response.status === 400 && mcp) {
      if (
        (mcpDropped = truncateErrorBody(response.data) || '(400, no body)'),
        logForDebugging(`[artifact] init 400 with mcp, retrying without: ${mcpDropped}`),
        (response = await init(false)),
        !response.ok
      ) {
        logFeatureBad('artifact_publish', response.reason ?? 'request_error')
        return artifactError(`publish unavailable: ${response.reason}`)
      }
    }
    if (response.status < 200 || response.status >= 300) {
      logFeatureBad('artifact_publish', 'init_failed')
      return artifactError(`init ${response.status}: ${truncateErrorBody(response.data)}`)
    }
    const { slug: newSlug, version, putURL, putHeaders } = (response.data ?? {}) as {
      slug?: string
      version?: string
      putURL?: string
      putHeaders?: PutHeaders
    }
    if (!newSlug || !version || !putURL) {
      logFeatureBad('artifact_publish', 'init_incomplete')
      return artifactError('init returned incomplete response')
    }
    const uploadResult = await uploadToPutUrl(putURL, rendered, MAX_ARTIFACT_BYTES, putHeaders)
    if (uploadResult) {
      await completeDeploy(newSlug, version, false)
      if (uploadResult.status === 403) {
        const fallback = await directPublishArtifact(
          rendered,
          { ...meta, slug: newSlug },
          mcpDropped ? undefined : mcp,
          mcpDropped,
        )
        if (fallback.err === null) {
          logFeatureSad('artifact_publish', 'upload_blocked_fallback')
        }
        return fallback
      }
      logFeatureBad('artifact_publish', uploadResult.precondition ? 'upload_precondition' : 'upload_failed')
      return artifactError(uploadResult.err)
    }
    await completeDeploy(newSlug, version, true)
    if (mcpDropped !== undefined) {
      logFeatureSad('artifact_publish', 'mcp_rejected')
    }
    logFeatureOk('artifact_publish')
    return {
      url: buildArtifactUrl(newSlug),
      slug: newSlug,
      version,
      err: null,
      ...(mcpDropped !== undefined && { mcpDropped }),
    }
  } catch (error) {
    logFeatureBad('artifact_publish', 'request_error')
    return artifactError(error instanceof Error ? error.message : String(error))
  }
}

// ---------------------------------------------------------------------------
// `R4f` — readArtifactContent (the WebFetch artifact-read path).
//
// Boot: authenticated GET /api/frame/{slug} (returns ver/assetToken/title/perm),
// then an external GET of the immutable asset on {slug}.frame.{env}
// claudeusercontent.com. Returns { err, status?, html?, role?, bytes?, title? }.
// ---------------------------------------------------------------------------

export type ArtifactReadResult = {
  err: string | null
  status?: number
  html?: string
  role?: 'owner' | 'reader'
  bytes?: number
  title?: string
}

export async function readArtifactContent(
  parsed: { slug: string; env: 'prod' | 'staging' },
  signal?: AbortSignal,
): Promise<ArtifactReadResult> {
  const { slug, env } = parsed
  const origin = getOauthConfig().CLAUDE_AI_ORIGIN
  const sessionEnv = origin.includes('staging') ? 'staging' : 'prod'
  if (env !== sessionEnv) {
    logFeatureBad('artifact_webfetch_read', 'env_mismatch')
    return {
      err: `that artifact URL is for ${env} claude.ai, but this session targets ${sessionEnv}`,
    }
  }
  let boot: FrameResponse
  try {
    boot = await firstPartyFrameRequest('GET', `/api/frame/${slug}`, {
      timeout: 15000,
      headers: { 'X-Frame-CP': 'go' },
      signal,
    })
  } catch (error) {
    return { err: 'artifact read failed (network error)' }
  }
  if (!boot.ok) {
    logFeatureBad('artifact_webfetch_read', boot.reason ?? 'request_error')
    return {
      err:
        boot.reason === 'no-auth'
          ? `not authenticated — run /login (${boot.detail})`
          : `artifact read unavailable: ${boot.reason}`,
    }
  }
  if (boot.status === 404) {
    logFeatureBad('artifact_webfetch_read', 'boot_404')
    return {
      err: 'artifact not found — it may have been deleted, or it has not been shared with you',
      status: 404,
    }
  }
  if (boot.status < 200 || boot.status >= 300) {
    logFeatureBad('artifact_webfetch_read', 'boot_failed')
    return { err: `artifact read failed (HTTP ${boot.status})`, status: boot.status }
  }
  const { ver, assetToken, title, perm } = (boot.data ?? {}) as {
    ver?: string
    assetToken?: string
    title?: string
    perm?: { role?: string }
  }
  if (!ver || !assetToken) {
    logFeatureBad('artifact_webfetch_read', 'boot_incomplete')
    return { err: 'artifact read failed: incomplete boot response' }
  }
  const role = perm?.role === 'owner' ? 'owner' : 'reader'
  const host = `${slug}.frame.${env === 'staging' ? 'staging.' : ''}claudeusercontent.com`
  let asset: AxiosResponse
  try {
    asset = await axios.get(`https://${host}/_f/${ver}/?__frame_t=${encodeURIComponent(assetToken)}`, {
      signal,
      timeout: 30000,
      responseType: 'arraybuffer',
      maxRedirects: 0,
      maxContentLength: MAX_ARTIFACT_BYTES + 4096,
      validateStatus: () => true,
    })
  } catch (error) {
    return { err: 'artifact content fetch failed (network error)' }
  }
  if (asset.status === 403 && asset.headers['x-proxy-error'] === 'blocked-by-allowlist') {
    logFeatureBad('artifact_webfetch_read', 'asset_egress_blocked')
    return {
      err: `the network egress proxy in this environment blocks ${host} — your access to the artifact itself is fine (the boot check passed)`,
      status: 403,
    }
  }
  if (asset.status < 200 || asset.status >= 300) {
    logFeatureBad('artifact_webfetch_read', 'asset_failed')
    return { err: `artifact content fetch failed (HTTP ${asset.status})`, status: asset.status }
  }
  const bytes = Buffer.from(asset.data as ArrayBuffer)
  logFeatureOk('artifact_webfetch_read')
  return {
    err: null,
    html: bytes.toString('utf-8').replace(`<base href="/_f/${ver}/">`, ''),
    role,
    bytes: bytes.length,
    title: title ?? '',
  }
}
