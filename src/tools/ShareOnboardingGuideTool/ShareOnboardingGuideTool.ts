import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getErrnoCode } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import {
  createOnboardingGuide,
  getMostRecentOnboardingGuide,
  updateOnboardingGuide,
} from './api.js'
import {
  MAX_ONBOARDING_SIZE_BYTES,
  ONBOARDING_FILE_NAME,
  SHARE_ONBOARDING_GUIDE_PROMPT,
  SHARE_ONBOARDING_GUIDE_SEARCH_HINT,
  SHARE_ONBOARDING_GUIDE_TOOL_NAME,
} from './constants.js'

/**
 * Official 2.1.128 v_8 — the share sub-feature is disabled under
 * essential-traffic mode, otherwise gated by the (default-off)
 * tengu_flint_harbor_share GrowthBook flag.
 */
function isShareOnboardingEnabled(): boolean {
  if (isEssentialTrafficOnly()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_flint_harbor_share',
    false,
  )
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    mode: z
      .enum(['check', 'update', 'create'])
      .default('check')
      .describe(
        "'check' (default): upload if no guide exists yet, otherwise report the existing one. 'update': replace the existing guide's content. 'create': always make a new link.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['created', 'updated', 'has_existing', 'unavailable']),
    share_url: z.string().optional(),
    short_code: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/** Official 2.1.128 Bx7 — success (created/updated) result + close-out line. */
function buildShareResult(
  status: Output['status'],
  shareUrl: string,
  shortCode: string,
): { data: Output } {
  return {
    data: {
      status,
      share_url: shareUrl,
      short_code: shortCode,
      message: `Share link ${status}: ${shareUrl}\n\nClose with: "Here's your onboarding guide: ${shareUrl}" followed by the send-to-teammates line.`,
    },
  }
}

/** Official 2.1.128 P26 — unavailable result. */
function buildUnavailableResult(message: string): { data: Output } {
  return { data: { status: 'unavailable', message } }
}

export const ShareOnboardingGuideTool = buildTool({
  name: SHARE_ONBOARDING_GUIDE_TOOL_NAME,
  searchHint: SHARE_ONBOARDING_GUIDE_SEARCH_HINT,
  maxResultSizeChars: 1000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return SHARE_ONBOARDING_GUIDE_PROMPT
  },
  isEnabled() {
    return isShareOnboardingEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async validateInput(): Promise<ValidationResult> {
    return { result: true }
  },
  async prompt() {
    return SHARE_ONBOARDING_GUIDE_PROMPT
  },
  toAutoClassifierInput(input) {
    return `share onboarding guide (mode: ${input.mode ?? 'check'})`
  },
  renderToolUseMessage(input) {
    return input.mode && input.mode !== 'check' ? input.mode : null
  },
  async call({ mode = 'check' }) {
    const guidePath = join(getOriginalCwd(), ONBOARDING_FILE_NAME)

    // Reject before reading: a missing file and an oversized file are the two
    // expected, user-actionable failure modes.
    let size: number
    try {
      size = (await stat(guidePath)).size
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return buildUnavailableResult(
          `${ONBOARDING_FILE_NAME} not found in the current directory. Write the guide first.`,
        )
      }
      throw error
    }

    if (size > MAX_ONBOARDING_SIZE_BYTES) {
      return buildUnavailableResult(
        `${ONBOARDING_FILE_NAME} is over ${MAX_ONBOARDING_SIZE_BYTES / 1024}KB. Trim it before sharing.`,
      )
    }

    const content = await readFile(guidePath, 'utf8')

    try {
      const existingGuide =
        mode === 'create'
          ? undefined
          : await getMostRecentOnboardingGuide()

      // check mode against an existing guide: surface the existing link instead
      // of uploading, and let the model ask before overwriting or forking.
      if (existingGuide && mode === 'check') {
        return {
          data: {
            status: 'has_existing',
            share_url: existingGuide.share_url,
            short_code: existingGuide.short_code,
            message: `A guide already exists for this org at ${existingGuide.share_url}. Ask the user whether to update it (mode: 'update') or create a new link (mode: 'create'), then call this tool again.`,
          },
        }
      }

      if (existingGuide && mode === 'update') {
        const updated = await updateOnboardingGuide(
          existingGuide.short_code,
          content,
        )
        return buildShareResult('updated', updated.share_url, updated.short_code)
      }

      const created = await createOnboardingGuide(content)
      return buildShareResult('created', created.share_url, created.short_code)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return buildUnavailableResult(
        `Upload didn't go through (${detail}). Fall back to the manual share copy.`,
      )
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `[${data.status}] ${data.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
