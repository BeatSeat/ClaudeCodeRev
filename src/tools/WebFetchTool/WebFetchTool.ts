import { STATUS_CODES } from 'http'
import { z } from 'zod/v4'
import { buildTool, toolMatchesName, type Tools, type ToolDef } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { formatFileSize } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import {
  parseArtifactUrl,
  type ParsedArtifactUrl,
} from '../ArtifactTool/artifactUrls.js'
import { isArtifactToolEnabled } from '../ArtifactTool/artifactGates.js'
import { readArtifactContent } from '../ArtifactTool/artifactPublish.js'
import { isPreapprovedHost } from './preapproved.js'
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import {
  applyPromptToMarkdown,
  ARTIFACT_HTML_DUMP_CAP,
  type FetchedContent,
  getURLMarkdownContent,
  isPreapprovedUrl,
  MAX_MARKDOWN_LENGTH,
  turndownHtmlString,
} from './utils.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('The URL to fetch content from'),
    prompt: z.string().describe('The prompt to run on the fetched content'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    bytes: z.number().describe('Size of the fetched content in bytes'),
    code: z.number().describe('HTTP response code'),
    codeText: z.string().describe('HTTP response code text'),
    result: z
      .string()
      .describe('Processed result from applying the prompt to the content'),
    durationMs: z
      .number()
      .describe('Time taken to fetch and process the content'),
    url: z.string().describe('The URL that was fetched'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/** Official 2.1.172 `JL4` — glob `*` → `[^.:]*` after escaping the rest. */
function escapeWebFetchDomainGlob(pattern: string): string {
  return pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.:]*')
}

/** Official 2.1.172 `DL4` — lowercase hostname; strip trailing dots before an optional port. */
function normalizeWebFetchDomainKey(key: string): string {
  if (!key.startsWith('domain:')) {
    return key
  }
  return `domain:${key.slice(7).toLowerCase().replace(/(?<=[^*.])\.+(?=(:\d+)?$)/, '')}`
}

/** Official 2.1.172 `o6f` — `domain:*.example.com` matches subdomains, not the apex. */
function webFetchDomainWildcardMatches(
  ruleKey: string,
  inputKey: string,
): boolean {
  if (!ruleKey.startsWith('domain:') || !inputKey.startsWith('domain:')) {
    return false
  }
  if (ruleKey === 'domain:*') {
    return true
  }
  const source = ruleKey.startsWith('domain:*.')
    ? `^domain:(?:[^.:]+\\.)+${escapeWebFetchDomainGlob(ruleKey.slice(9))}$`
    : `^domain:${escapeWebFetchDomainGlob(ruleKey.slice(7))}$`
  return new RegExp(source, 'i').test(inputKey)
}

/** Official 2.1.172 `Ay8` — exact Map hit, else first wildcard match. */
function matchWebFetchDomainRule<T>(
  rules: Map<string, T>,
  key: string,
): T | undefined {
  const exact = rules.get(key)
  if (exact) {
    return exact
  }
  const normalizedInput = normalizeWebFetchDomainKey(key)
  let wildcard: T | undefined
  for (const [ruleKey, rule] of rules) {
    const normalizedRule = normalizeWebFetchDomainKey(ruleKey)
    if (!normalizedRule.includes('*')) {
      if (normalizedRule === normalizedInput) {
        return rule
      }
    } else if (
      wildcard === undefined &&
      webFetchDomainWildcardMatches(normalizedRule, normalizedInput)
    ) {
      wildcard = rule
    }
  }
  return wildcard
}

/** Official 2.1.172 (G2) `ay8` — HTTP status code → reason-phrase text. */
function httpStatusText(status: number): string {
  return STATUS_CODES?.[status] ?? 'Unknown Status'
}

/**
 * Official 2.1.172 (G2) `u4f` — if the Artifact tool is present in the active
 * tool set AND enabled, parse the URL as an artifact slug. Returns null for
 * non-artifact URLs (fall through to the normal fetch path).
 */
function getArtifactSlug(
  url: string,
  tools: Tools,
): ParsedArtifactUrl | null {
  const hasArtifactTool = tools.some(tool => toolMatchesName(tool, 'Artifact'))
  if (!hasArtifactTool || !isArtifactToolEnabled()) {
    return null
  }
  return parseArtifactUrl(url)
}

/**
 * Official 2.1.172 (G2) — the artifact read-path. Reads the artifact content
 * (boot + asset), then:
 *   - if `err`, return an error output (or throw when no HTTP status)
 *   - if `role === 'owner'`, dump the raw HTML (capped) straight to the model
 *   - otherwise run the prompt over a Turndown conversion of the HTML
 */
async function fetchArtifactContent(
  parsed: ParsedArtifactUrl,
  prompt: string,
  url: string,
  abortController: AbortController,
  isNonInteractiveSession: boolean,
  start: number,
): Promise<Output> {
  const read = await readArtifactContent(parsed, abortController.signal)
  if (read.err !== null) {
    if (read.status === undefined) {
      throw new Error(`Artifact ${parsed.slug}: ${read.err}`)
    }
    return {
      bytes: 0,
      code: read.status,
      codeText: httpStatusText(read.status),
      result: `Artifact ${parsed.slug}: ${read.err}`,
      durationMs: Date.now() - start,
      url,
    }
  }

  const html = read.html ?? ''
  let result: string
  if (read.role === 'owner') {
    const titleSuffix = read.title
      ? ` "${read.title.length > 200 ? read.title.slice(0, 200) : read.title}"`
      : ''
    const sizeNote =
      html.length > ARTIFACT_HTML_DUMP_CAP
        ? `; first ${ARTIFACT_HTML_DUMP_CAP} chars of ${read.bytes ?? html.length} bytes follow`
        : '; raw HTML follows'
    result = `[Artifact ${parsed.slug}${titleSuffix} — owned by you${sizeNote}]\n${
      html.length > ARTIFACT_HTML_DUMP_CAP ? html.slice(0, ARTIFACT_HTML_DUMP_CAP) : html
    }`
  } else {
    const markdown = await turndownHtmlString(html)
    result = await applyPromptToMarkdown(
      prompt,
      markdown,
      abortController.signal,
      isNonInteractiveSession,
      false,
    )
  }

  return {
    bytes: read.bytes ?? 0,
    code: 200,
    codeText: 'OK',
    result,
    durationMs: Date.now() - start,
    url,
  }
}

function webFetchToolInputToPermissionRuleContent(input: {
  [k: string]: unknown
}): string {
  try {
    const parsedInput = WebFetchTool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return `input:${input.toString()}`
    }
    const { url } = parsedInput.data
    const hostname = new URL(url).hostname
    return `domain:${hostname}`
  } catch {
    return `input:${input.toString()}`
  }
}

export const WebFetchTool = buildTool({
  name: WEB_FETCH_TOOL_NAME,
  searchHint: 'fetch and extract content from a URL',
  // 100K chars - tool result persistence threshold
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    const { url } = input as { url: string }
    try {
      const hostname = new URL(url).hostname
      return `Claude wants to fetch content from ${hostname}`
    } catch {
      return `Claude wants to fetch content from this URL`
    }
  },
  userFacingName() {
    return 'Fetch'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Fetching ${summary}` : 'Fetching web page'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // Check if the hostname is in the preapproved list
    try {
      const { url } = input as { url: string }
      const parsedUrl = new URL(url)
      if (isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'other', reason: 'Preapproved host' },
        }
      }
    } catch {
      // If URL parsing fails, continue with normal permission checks
    }

    // Check for a rule specific to the tool input (matching hostname)
    const ruleContent = webFetchToolInputToPermissionRuleContent(input)

    const denyRule = matchWebFetchDomainRule(
      getRuleByContentsForTool(permissionContext, WebFetchTool, 'deny'),
      ruleContent,
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${WebFetchTool.name} denied access to ${ruleContent}.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }

    const askRule = matchWebFetchDomainRule(
      getRuleByContentsForTool(permissionContext, WebFetchTool, 'ask'),
      ruleContent,
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to use ${WebFetchTool.name}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        suggestions: buildSuggestions(ruleContent),
      }
    }

    const allowRule = matchWebFetchDomainRule(
      getRuleByContentsForTool(permissionContext, WebFetchTool, 'allow'),
      ruleContent,
    )
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: allowRule,
        },
      }
    }

    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${WebFetchTool.name}, but you haven't granted it yet.`,
      suggestions: buildSuggestions(ruleContent),
    }
  },
  async prompt(_options) {
    // Always include the auth warning regardless of whether ToolSearch is
    // currently in the tools list. Conditionally toggling this prefix based
    // on ToolSearch availability caused the tool description to flicker
    // between SDK query() calls (when ToolSearch enablement varies due to
    // MCP tool count thresholds), invalidating the Anthropic API prompt
    // cache on each toggle — two consecutive cache misses per flicker event.
    return `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.
${DESCRIPTION}`
  },
  async validateInput(input) {
    const { url } = input
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `Error: Invalid URL "${url}". The URL provided could not be parsed.`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(
    { url, prompt },
    { abortController, options },
  ) {
    const start = Date.now()

    // Official 2.1.172 (G2) — artifact read-path. If this URL is an artifact
    // slug and the Artifact tool is active, read the page content directly
    // (no WebFetch redirect/blocklist flow) and short-circuit.
    const artifact = getArtifactSlug(url, options.tools)
    if (artifact) {
      return {
        data: await fetchArtifactContent(
          artifact,
          prompt,
          url,
          abortController,
          options.isNonInteractiveSession,
          start,
        ),
      }
    }

    const response = await getURLMarkdownContent(url, abortController)

    // Check if we got a redirect to a different host
    if ('type' in response && response.type === 'redirect') {
      const statusText =
        response.statusCode === 301
          ? 'Moved Permanently'
          : response.statusCode === 308
            ? 'Permanent Redirect'
            : response.statusCode === 307
              ? 'Temporary Redirect'
              : 'Found'

      const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`

      const output: Output = {
        bytes: Buffer.byteLength(message),
        code: response.statusCode,
        codeText: statusText,
        result: message,
        durationMs: Date.now() - start,
        url,
      }

      return {
        data: output,
      }
    }

    const {
      content,
      bytes,
      code,
      codeText,
      contentType,
      persistedPath,
      persistedSize,
    } = response as FetchedContent

    const isPreapproved = isPreapprovedUrl(url)

    let result: string
    if (
      isPreapproved &&
      contentType.includes('text/markdown') &&
      content.length < MAX_MARKDOWN_LENGTH
    ) {
      result = content
    } else {
      result = await applyPromptToMarkdown(
        prompt,
        content,
        abortController.signal,
        options.isNonInteractiveSession,
        isPreapproved,
      )
    }

    // Binary content (PDFs, etc.) was additionally saved to disk with a
    // mime-derived extension. Note it so Claude can inspect the raw file
    // if the Haiku summary above isn't enough.
    if (persistedPath) {
      result += `\n\n[Binary content (${contentType}, ${formatFileSize(persistedSize ?? bytes)}) also saved to ${persistedPath}]`
    }

    const output: Output = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url,
    }

    return {
      data: output,
    }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function buildSuggestions(ruleContent: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: WEB_FETCH_TOOL_NAME, ruleContent }],
      behavior: 'allow',
    },
  ]
}
