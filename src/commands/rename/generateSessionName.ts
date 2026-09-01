import { queryHaiku } from '../../services/api/claude.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Message } from '../../types/message.js'
import {
  getLastCacheSafeParams,
  isMainThreadCacheWarm,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  createUserMessage,
  extractTextContent,
} from '../../utils/messages.js'
import { extractConversationText } from '../../utils/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

/**
 * Strip a single surrounding Markdown code fence (```lang ... ```) that the
 * model sometimes wraps JSON responses in. Verbatim 2.1.147 JS.
 */
function stripMarkdownCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

/**
 * Parse a model JSON response for a session name. Strips any code fence,
 * parses, and returns the "name" field if it is a string. Verbatim 2.1.147 PG4.
 */
function parseRenameName(text: string): string | null {
  const parsed = safeParseJSON(stripMarkdownCodeFence(text), false)
  if (
    parsed &&
    typeof parsed === 'object' &&
    'name' in parsed &&
    typeof (parsed as { name: unknown }).name === 'string'
  ) {
    return (parsed as { name: string }).name
  }
  return null
}

/**
 * Generate a session name by forking the whole session: run the main agent's
 * model with the conversation context already in the prompt cache, asking it
 * to name the session. Cheaper than a fresh haiku call because it reuses the
 * warm prompt cache.
 *
 * Verbatim 2.1.147 hC5. Returns null when no cache-safe snapshot is saved,
 * when the signal aborts, or on any error.
 */
async function generateSessionNameByFork(
  signal: AbortSignal,
): Promise<string | null> {
  const cacheSafeParams = getLastCacheSafeParams()
  if (!cacheSafeParams) {
    return null
  }
  const forkAbortController = new AbortController()
  signal.addEventListener(
    'abort',
    () => forkAbortController.abort(),
    { once: true },
  )

  try {
    const { messages } = await runForkedAgent({
      promptMessages: [
        createUserMessage({
          content:
            'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures". Return JSON with a "name" field.',
        }),
      ],
      cacheSafeParams,
      overrides: { abortController: forkAbortController },
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'Session name generation cannot use tools',
        decisionReason: { type: 'other' as const, reason: 'rename' },
      }),
      querySource: 'rename_generate_name',
      forkLabel: 'rename',
      maxTurns: 1,
      skipCacheWrite: true,
      skipTranscript: true,
    })

    if (signal.aborted) {
      return null
    }

    // extractTextContent already filters to text blocks and joins them with
    // the empty separator — matches the bundle's flatMap/filter/map/join('').
    const text = extractTextContent(
      messages.flatMap(m =>
        m.type === 'assistant' && !m.isApiErrorMessage
          ? m.message.content
          : [],
      ),
    ).trim()

    return parseRenameName(text)
  } catch (error) {
    if (!signal.aborted) {
      logForDebugging(`generateSessionName fork failed: ${errorMessage(error)}`, {
        level: 'error',
      })
    }
    return null
  }
}

export async function generateSessionName(
  messages: Message[],
  signal: AbortSignal,
  options?: { preferFork?: boolean },
): Promise<string | null> {
  // Official 2.1.147 tengu_rename_full_session_fork: when the caller asks to
  // prefer forking, the feature flag is on, and the main thread's prompt cache
  // is still warm, fork the whole session instead of calling haiku. If the
  // fork produces a name use it; if the signal aborted mid-fork give up;
  // otherwise fall through to the haiku path below.
  if (
    options?.preferFork &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_rename_full_session_fork', false) &&
    isMainThreadCacheWarm()
  ) {
    const forkedName = await generateSessionNameByFork(signal)
    if (forkedName) {
      return forkedName
    }
    if (signal.aborted) {
      return null
    }
  }

  const conversationText = extractConversationText(messages)
  if (!conversationText) {
    return null
  }

  try {
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([
        'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures". Return JSON with a "name" field.',
      ]),
      userPrompt: conversationText,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'rename_generate_name',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    const content = extractTextContent(result.message.content)

    const response = safeParseJSON(content)
    if (
      response &&
      typeof response === 'object' &&
      'name' in response &&
      typeof (response as { name: unknown }).name === 'string'
    ) {
      return (response as { name: string }).name
    }
    return null
  } catch (error) {
    // Haiku timeout/rate-limit/network are expected operational failures —
    // logForDebugging, not logError. Called automatically on every 3rd bridge
    // message (initReplBridge.ts), so errors here would flood the error file.
    logForDebugging(`generateSessionName failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    return null
  }
}
