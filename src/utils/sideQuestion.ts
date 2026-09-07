/**
 * Side Question ("/btw") feature - allows asking quick questions without
 * interrupting the main agent context.
 *
 * Uses runForkedAgent to leverage prompt caching from the parent context
 * while keeping the side question response separate from main conversation.
 */

import {
  appendBtwHistory,
  getBtwHistory,
} from '../commands/btw/btwHistory.js'
import { formatAPIError } from '../services/api/errorUtils.js'
import type { NonNullableUsage } from '../services/api/logging.js'
import type { Message, SystemAPIErrorMessage } from '../types/message.js'
import type { QuerySource } from '../constants/querySource.js'
import { type CacheSafeParams, runForkedAgent } from './forkedAgent.js'
import {
  createAssistantMessage,
  createUserMessage,
  extractTextContent,
} from './messages.js'

// Pattern to detect "/btw" at start of input (case-insensitive, word boundary)
const BTW_PATTERN = /^\/btw\b/gi

/**
 * Find positions of "/btw" keyword at the start of text for highlighting.
 * Similar to findThinkingTriggerPositions in thinking.ts.
 */
export function findBtwTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  const matches = text.matchAll(BTW_PATTERN)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

export type SideQuestionResult = {
  response: string | null
  /** Official 2.1.187 — tool-fallback / API-error answers are synthetic. */
  synthetic: boolean
  usage: NonNullableUsage
}

/**
 * Official 2.1.187 `Wjp` — extract display string + synthetic flag.
 */
function extractSideQuestionResponse(messages: Message[]): {
  response: string | null
  synthetic: boolean
} {
  const assistantBlocks = messages.flatMap(m =>
    m.type === 'assistant' ? m.message.content : [],
  )

  if (assistantBlocks.length > 0) {
    const text = extractTextContent(assistantBlocks, '\n\n').trim()
    if (text) return { response: text, synthetic: false }

    const toolUse = assistantBlocks.find(b => b.type === 'tool_use')
    if (toolUse) {
      const toolName = 'name' in toolUse ? toolUse.name : 'a tool'
      return {
        response: `(The model tried to call ${toolName} instead of answering directly. Try rephrasing or ask in the main conversation.)`,
        synthetic: true,
      }
    }
  }

  const apiErr = messages.find(
    (m): m is SystemAPIErrorMessage =>
      m.type === 'system' && 'subtype' in m && m.subtype === 'api_error',
  )
  if (apiErr) {
    return {
      response: `(API error: ${formatAPIError(apiErr.error)})`,
      synthetic: true,
    }
  }

  return { response: null, synthetic: false }
}

/**
 * Run a side question using a forked agent.
 * Shares the parent's prompt cache — no thinking override, no cache write.
 * All tools are blocked and we cap at 1 turn.
 *
 * Official 2.1.187 `e6n`: when `threadHistory` is true (default), prior /btw
 * Q&A pairs are prepended and a successful non-synthetic answer is appended
 * to the module history store.
 */
export async function runSideQuestion({
  question,
  cacheSafeParams,
  threadHistory = true,
}: {
  question: string
  cacheSafeParams: CacheSafeParams
  threadHistory?: boolean
}): Promise<SideQuestionResult> {
  // Wrap the question with instructions to answer without tools
  const wrappedQuestion = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`

  const historyMessages = threadHistory
    ? getBtwHistory().flatMap(entry => [
        createUserMessage({ content: entry.question }),
        createAssistantMessage({ content: entry.response }),
      ])
    : []

  const agentResult = await runForkedAgent({
    promptMessages: [
      ...historyMessages,
      createUserMessage({ content: wrappedQuestion }),
    ],
    // Do NOT override thinkingConfig — thinking is part of the API cache key,
    // and diverging from the main thread's config busts the prompt cache.
    // Adaptive thinking on a quick Q&A has negligible overhead.
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny' as const,
      message: 'Side questions cannot use tools',
      decisionReason: { type: 'other' as const, reason: 'side_question' },
    }),
    querySource: 'side_question' as QuerySource,
    forkLabel: 'side_question',
    maxTurns: 1, // Single turn only - no tool use loops
    // No future request shares this suffix; skip writing cache entries.
    skipCacheWrite: true,
  })

  const { response, synthetic } = extractSideQuestionResponse(
    agentResult.messages,
  )
  if (threadHistory && response && !synthetic) {
    appendBtwHistory(question, response)
  }

  return {
    response,
    synthetic,
    usage: agentResult.totalUsage,
  }
}
