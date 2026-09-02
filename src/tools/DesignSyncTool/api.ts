import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getUserAgent } from '../../utils/http.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'
import {
  DESIGN_SYNC_CLIENT,
  OMELETTE_SERVICE,
  PROJECT_TYPE_DESIGN_SYSTEM,
} from './constants.js'

/** Official 2.1.160 `nv$`. */
export class DesignRpcError extends Error {
  method: string
  status: number
  body: unknown
  constructor(method: string, status: number, body: unknown) {
    super(`Design API ${method} failed: HTTP ${status} ${formatRpcBody(body)}`)
    this.name = 'DesignRpcError'
    this.method = method
    this.status = status
    this.body = body
  }
}

/** Official 2.1.160 `LJ4`. */
export class DesignAuthError extends DesignRpcError {
  constructor(method: string, status: number, body: unknown) {
    super(method, status, body)
    this.name = 'DesignAuthError'
  }
}

/** Official 2.1.160 `xc5`. */
function formatRpcBody(body: unknown): string {
  if (body == null) return ''
  if (typeof body === 'string') return body.slice(0, 200)
  try {
    return JSON.stringify(body).slice(0, 200)
  } catch {
    return String(body).slice(0, 200)
  }
}

/** Official 2.1.160 `bc5`. */
function omelettePath(method: string): string {
  return `/${OMELETTE_SERVICE}/${method}`
}

/** Official 2.1.160 `XJ4`. */
export function redactOAuthToken(message: string, token: string): string {
  if (!token) return message
  return message.split(token).join('[redacted-oauth-token]')
}

/**
 * Official 2.1.160 `tAH`.
 * `G7.post(..., {auth:"none", headers:{...PJ(token), "X-Anthropic-Client":"claude-cli-design-sync"}})`.
 */
export async function designRpc<T>(
  method: string,
  accessToken: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${getOauthConfig().BASE_API_URL}${omelettePath(method)}`
  let response: { status: number; data: unknown; ok?: boolean; reason?: string }
  try {
    const axiosResponse = await axios.post(url, body, {
      headers: {
        ...getOAuthHeaders(accessToken),
        'X-Anthropic-Client': DESIGN_SYNC_CLIENT,
        'User-Agent': getUserAgent(),
      },
      timeout: 60_000,
      validateStatus: () => true,
      signal,
    })
    response = {
      ok: true,
      status: axiosResponse.status,
      data: axiosResponse.data,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new DesignRpcError(method, 0, { error: reason })
  }
  if (!response.ok) {
    throw new DesignRpcError(method, 0, { error: response.reason })
  }
  if (response.status === 401 || response.status === 403) {
    throw new DesignAuthError(method, response.status, response.data)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DesignRpcError(method, response.status, response.data)
  }
  return response.data as T
}

/** Official 2.1.160 `zJ4`. */
export async function listOrgProjects(
  accessToken: string,
  opts: { type?: string; cursor?: string } = {},
  signal?: AbortSignal,
) {
  const data = await designRpc<{
    items?: Array<Record<string, unknown>>
    cursor?: string
  }>(
    'ListOrgProjects',
    accessToken,
    {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    },
    signal,
  )
  return { items: data.items ?? [], cursor: data.cursor ?? '' }
}

/** Official 2.1.160 `fJ4`. */
export async function writeFiles(
  accessToken: string,
  projectId: string,
  files: unknown[],
  opts: { deduplicate?: boolean; deletePaths?: string[] } = {},
  signal?: AbortSignal,
) {
  const data = await designRpc<{ files?: unknown[] }>(
    'WriteFiles',
    accessToken,
    {
      projectId,
      files,
      deduplicate: opts.deduplicate ?? false,
      ...(opts.deletePaths?.length ? { deletePaths: opts.deletePaths } : {}),
    },
    signal,
  )
  return data.files ?? []
}

/** Official 2.1.160 `YJ4`. */
export async function getProject(
  accessToken: string,
  projectId: string,
  signal?: AbortSignal,
) {
  return designRpc<Record<string, unknown>>(
    'GetProject',
    accessToken,
    { projectId },
    signal,
  )
}

/** Official 2.1.160 `OJ4`. */
export async function listFiles(
  accessToken: string,
  projectId: string,
  signal?: AbortSignal,
) {
  const data = await designRpc<{ entries?: Array<{ path: string }> }>(
    'ListFiles',
    accessToken,
    { projectId, depth: -1 },
    signal,
  )
  return (data.entries ?? []).map(entry => entry.path)
}

/** Official 2.1.160 `MJ4`. */
export async function getFile(
  accessToken: string,
  projectId: string,
  filePath: string,
  maxBytes = 262144,
  signal?: AbortSignal,
) {
  const data = await designRpc<{
    content?: string
    isBase64?: boolean
    contentType?: string
  }>('GetFile', accessToken, { projectId, path: filePath, raw: true }, signal)
  const raw = data.content ?? ''
  const isBase64 = data.isBase64 ?? false
  let content: string
  let truncated = false
  if (isBase64) {
    content = raw
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes)
      truncated = true
    }
  } else {
    let buf = Buffer.from(raw, 'base64')
    if (buf.byteLength > maxBytes) {
      buf = buf.subarray(0, maxBytes)
      truncated = true
    }
    content = buf.toString('utf8')
  }
  return {
    content,
    contentType: data.contentType ?? '',
    isBase64,
    truncated,
  }
}

/** Official 2.1.160 `wJ4`. */
export async function deleteFiles(
  accessToken: string,
  projectId: string,
  paths: string[],
  signal?: AbortSignal,
) {
  if (paths.length === 0) return 0
  const data = await designRpc<{ deleted?: number }>(
    'DeleteFiles',
    accessToken,
    { projectId, paths },
    signal,
  )
  return data.deleted ?? 0
}

/** Official 2.1.160 `jJ4`. */
export async function createProject(
  accessToken: string,
  name: string,
  signal?: AbortSignal,
) {
  const data = await designRpc<{ projectId?: string }>(
    'CreateProject',
    accessToken,
    { name, type: PROJECT_TYPE_DESIGN_SYSTEM },
    signal,
  )
  if (!data.projectId) {
    throw new DesignRpcError('CreateProject', 200, data)
  }
  return { projectId: data.projectId, name }
}

/** Official 2.1.160 `DJ4`. */
export async function recordAsset(
  accessToken: string,
  projectId: string,
  asset: {
    name: string
    path: string
    subtitle?: string
    viewport?: unknown
    group?: string
  },
  signal?: AbortSignal,
) {
  await designRpc(
    'RecordAsset',
    accessToken,
    {
      projectId,
      name: asset.name,
      path: asset.path,
      ...(asset.subtitle ? { subtitle: asset.subtitle } : {}),
      ...(asset.viewport ? { viewport: asset.viewport } : {}),
      ...(asset.group ? { section: asset.group } : {}),
    },
    signal,
  )
}

/** Official 2.1.160 `JJ4`. */
export async function deleteAsset(
  accessToken: string,
  projectId: string,
  assetPath: string,
  signal?: AbortSignal,
) {
  await designRpc(
    'DeleteAsset',
    accessToken,
    { projectId, path: assetPath },
    signal,
  )
}
