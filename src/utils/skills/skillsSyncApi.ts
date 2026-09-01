import axios from 'axios'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOrganizationUUID } from '../../services/oauth/client.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
} from '../auth.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { classifyAxiosError } from '../errors.js'
import { getUserAgent } from '../http.js'
import { getAPIProvider } from '../model/providers.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { getOAuthHeaders } from '../teleport/api.js'

/** Official 2.1.149 `tkA`. */
const LIST_SKILLS_TIMEOUT_MS = 30_000
/** Official 2.1.149 `ekA`. */
const DOWNLOAD_SKILL_TIMEOUT_MS = 300_000

/**
 * Official 2.1.149 `$NA`. `:orgUUID` is substituted after teleport-org auth
 * resolves the active organization (same as `$4.get` / `o3$`).
 */
export const LIST_SKILLS_PATH =
  '/api/oauth/organizations/:orgUUID/skills/list-skills?include_wiggle_skills=true'

export type SyncedSkillRecord = {
  skillId: string
  name: string
  description: string
  source: string
  updatedAt: string | null
}

type ApiSkill = {
  id: string
  name: string
  description?: string
  source?: string
  updated_at?: string | null
  enabled?: boolean
}

type TeleportGetResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; detail?: string }

type ListSkillsResponse = {
  skills?: ApiSkill[]
}

/** Official 2.1.149 `HNA`. */
const downloadErrorEnvelopeSchema = z.object({
  error: z.object({ type: z.string().optional() }),
})

/** Official 2.1.149 `ID9`. */
export function mapApiSkill(skill: ApiSkill): SyncedSkillRecord {
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description ?? '',
    source: skill.source ?? 'custom',
    updatedAt: skill.updated_at ?? null,
  }
}

/** Official 2.1.149 `CD9`. */
export function isRemoteSkillEnabled(skill: ApiSkill): boolean {
  return skill.enabled !== false
}

/**
 * Official 2.1.149 `qNA`. Best-effort parse of a non-zip download body.
 */
export function parseDownloadServerError(body: Buffer): string {
  try {
    const parsed = downloadErrorEnvelopeSchema.safeParse(
      JSON.parse(body.toString('utf8', 0, 2048)),
    )
    if (parsed.success) {
      return parsed.data.error.type ?? 'error_envelope_no_type'
    }
  } catch {
    // fall through
  }
  return 'non_json_body'
}

async function teleportOrgGet<T>(
  pathTemplate: string,
  opts: { timeout: number; responseType?: 'arraybuffer' },
): Promise<TeleportGetResult<T>> {
  // Official `o3$` gates for `auth:"teleport-org"`.
  if (isEssentialTrafficOnly()) {
    return { ok: false, reason: 'essential-traffic-only' }
  }
  if (getAPIProvider() !== 'firstParty') {
    return { ok: false, reason: 'data-residency' }
  }

  await checkAndRefreshOAuthTokenIfNeeded()
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    return {
      ok: false,
      reason: 'no-auth',
      detail: 'No OAuth token in keychain',
    }
  }

  const orgUUID = await getOrganizationUUID()
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken || !orgUUID) {
    return {
      ok: false,
      reason: 'no-auth',
      detail: 'No OAuth token in keychain',
    }
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
    'User-Agent': getUserAgent(),
  }
  const url = `${getOauthConfig().BASE_API_URL}${pathTemplate.replace(':orgUUID', orgUUID)}`
  const response = await axios.get<T>(url, {
    headers,
    timeout: opts.timeout,
    responseType: opts.responseType,
  })
  return { ok: true, data: response.data }
}

export type ListSkillsResult =
  | { success: true; skills: SyncedSkillRecord[] }
  | { success: false; error: string }

/** Official 2.1.149 `xD9`. */
export async function listRemoteSkills(): Promise<ListSkillsResult> {
  try {
    const result = await teleportOrgGet<ListSkillsResponse>(LIST_SKILLS_PATH, {
      timeout: LIST_SKILLS_TIMEOUT_MS,
    })
    if (result.ok === false) {
      return {
        success: false,
        error:
          result.reason === 'no-auth'
            ? (result.detail ?? result.reason)
            : result.reason,
      }
    }
    if (!Array.isArray(result.data?.skills)) {
      logForDiagnosticsNoPII('warn', 'skills_sync_list_malformed')
      return { success: false, error: 'malformed list-skills response' }
    }
    return {
      success: true,
      skills: result.data.skills.filter(isRemoteSkillEnabled).map(mapApiSkill),
    }
  } catch (error) {
    const { message } = classifyAxiosError(error)
    return { success: false, error: message }
  }
}

/** Official 2.1.149 `uD9`. */
export async function downloadSkillZip(
  skillId: string,
  destPath: string,
): Promise<boolean> {
  try {
    const result = await teleportOrgGet<ArrayBuffer>(
      `/api/oauth/organizations/:orgUUID/skills/${encodeURIComponent(skillId)}/download`,
      { timeout: DOWNLOAD_SKILL_TIMEOUT_MS, responseType: 'arraybuffer' },
    )
    if (result.ok === false) {
      logForDiagnosticsNoPII('warn', 'skills_sync_download_not_ok', {
        reason: result.reason,
      })
      return false
    }
    if (!result.data) {
      logForDiagnosticsNoPII('warn', 'skills_sync_download_not_ok', {
        reason: 'empty_body',
      })
      return false
    }
    const bytes = Buffer.from(result.data)
    if (bytes.length < 2 || bytes[0] !== 80 || bytes[1] !== 75) {
      logForDiagnosticsNoPII('warn', 'skills_sync_download_not_zip', {
        serverError: parseDownloadServerError(bytes),
        bodyLen: bytes.length,
      })
      return false
    }
    await writeFile(destPath, bytes)
    return true
  } catch (error) {
    const { kind } = classifyAxiosError(error)
    logForDiagnosticsNoPII('warn', 'skills_sync_download_exception', { kind })
    return false
  }
}
