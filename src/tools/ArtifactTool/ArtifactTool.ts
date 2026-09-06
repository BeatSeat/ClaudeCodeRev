/**
 * Official 2.1.172 (G2 — tengu_cobalt_plinth / tengu_cobalt_plinth_direct):
 * the "Artifact" tool — renders an HTML or Markdown file to a default-private
 * claude.ai web page and returns its URL. Net-new in the 2.1.170 → 2.1.172
 * hop; the whole tool + publish engine + WebFetch read path are absent from
 * the 172 tree before this port.
 *
 * The tool is gated by isArtifactToolEnabled() (see artifactGates.ts).
 *
 * NOTE on the port boundary: the bundle's full ArtifactTool also wires in
 * (a) the frame-MCP input option (behind a `_OH` frame-MCP provider that is
 * absent from this tree), (b) a per-session "already-published this session"
 * auto-allow keyed off appState.frameUrls, and (c) a permission matcher over
 * the rendered file path. Those three touch subsystems that are not yet in
 * the 172 tree, so this port lands the tool body, schema, prompt, publish
 * call and read path; the frame-MCP / frameUrls auto-allow are left out
 * (see the G2 gap notes) rather than importing symbols that don't exist.
 */
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { z } from 'zod/v4'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { expandPath } from '../../utils/path.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractHtmlTitle,
  sanitizeArtifactTitle,
  TITLE_SCAN_BYTES,
  type ParsedArtifactUrl,
  ARTIFACT_TOOL_NAME,
  parseArtifactUrl,
} from './artifactUrls.js'
import { isArtifactToolEnabled } from './artifactGates.js'
import {
  publishArtifact,
  type PublishResult,
} from './artifactPublish.js'
import { ARTIFACT_TOOL_PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'Path to an .html or .md file to render. Use a short, distinctive basename — it is the fallback title if the HTML has no <title>.',
      ),
    favicon: z
      .string()
      .min(1)
      .max(32)
      .describe(
        'Browser-tab icon: one or two emoji (e.g. "\uD83D\uDCCA"). No markup. Keep stable across redeploys; change only on a hard topic pivot.',
      ),
    label: z
      .string()
      .max(60)
      .optional()
      .describe(
        'Short human-readable name for this version (e.g. "fixed-background"). Shown in the version picker instead of the raw version id.',
      ),
    url: z
      .string()
      .optional()
      .describe(
        'Existing artifact URL to redeploy to. Pass when the user gives you a URL for an artifact not published in this session; omit for new artifacts or same-session redeploys. Must be an artifact the user owns.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    url: z.string(),
    path: z.string(),
    title: z.string().optional(),
    mcpDropped: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * Derive the title for a render: for HTML, run extractHtmlTitle over the
 * first TITLE_SCAN_BYTES of the file; otherwise (e.g. .md) fall back to a
 * sanitized basename. Returns null when nothing usable is found.
 */
async function deriveTitle(
  resolvedPath: string,
  isMarkdown: boolean,
): Promise<string | null> {
  if (!isMarkdown) {
    try {
      const handle = await readFile(resolvedPath)
      const bytes = handle.subarray(0, TITLE_SCAN_BYTES)
      return extractHtmlTitle(bytes.toString('utf-8'))
    } catch {
      // unreadable — fall through to basename
    }
  }
  return sanitizeArtifactTitle(basename(resolvedPath))
}

export const ArtifactTool = buildTool({
  name: ARTIFACT_TOOL_NAME,
  searchHint: 'render an HTML or Markdown file to a claude.ai web page',
  maxResultSizeChars: 10_000,
  shouldDefer: false,
  async description({ file_path, url }: { file_path: string; url?: string }) {
    if (url) {
      return `Republish ${url} from ${file_path}`
    }
    return `Render ${file_path} as a default-private claude.ai artifact`
  },
  renderToolUseMessage() {
    return null
  },
  userFacingName() {
    return 'Artifact'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isArtifactToolEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  getPath({ file_path }: { file_path: string }): string {
    return expandPath(file_path)
  },
  async checkPermissions(
    input: { file_path: string; url?: string },
    context,
  ): Promise<PermissionDecision> {
    const appState = context.getAppState()
    // A redeploy of a URL that is itself an artifact (parseable slug) and not
    // otherwise pre-authorized is the caller to decide; mirror the bundle by
    // delegating to the general read-permission flow over the rendered path.
    void appState
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${ArtifactTool.name}, but you haven't granted it yet.`,
      decisionReason: { type: 'other', reason: 'Artifact publish requires approval' },
    }
  },
  async prompt() {
    return ARTIFACT_TOOL_PROMPT
  },
  async validateInput(
    { url },
    _context,
  ): Promise<ValidationResult> {
    if (url !== undefined) {
      const parsed: ParsedArtifactUrl | null = parseArtifactUrl(url)
      if (parsed === null) {
        return {
          result: false,
          message: `not an artifact URL: ${url}`,
          errorCode: 1,
        }
      }
    }
    return { result: true }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.url
        ? `Artifact published: ${output.url}`
        : 'Artifact publish failed',
    }
  },
  async call(
    { file_path, favicon, label, url },
    context,
  ): Promise<{ data: Output }> {
    const resolvedPath = expandPath(file_path)
    const isMarkdown = resolvedPath.toLowerCase().endsWith('.md')
    const html = (await readFile(resolvedPath)).toString('utf-8')

    // Re-target an existing artifact the user named, or keep the slug the
    // previous publish used (same-session redeploy is implicit via no url).
    const parsed = url !== undefined ? parseArtifactUrl(url) : null
    const existingSlug = parsed?.slug

    const title = await deriveTitle(resolvedPath, isMarkdown)
    const result: PublishResult = await publishArtifact(html, {
      slug: existingSlug,
      title,
      favicon,
      label,
    })

    if (result.err !== null || result.url === null) {
      throw new Error(result.err ?? 'artifact publish failed')
    }

    return {
      data: {
        url: result.url,
        path: resolvedPath,
        ...(title !== null && { title }),
        ...(result.mcpDropped !== undefined && { mcpDropped: result.mcpDropped }),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
