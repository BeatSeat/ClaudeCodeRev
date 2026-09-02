import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import { groupMessagesByApiRound } from '../../services/compact/grouping.js'
import { roughTokenCountEstimationForMessage } from '../../services/tokenEstimation.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { has1mContext, MODEL_CONTEXT_WINDOW_DEFAULT } from '../context.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import type { PromptHook } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../tokens.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

/** Official qQY — keep ~70% of the evaluator context window for Stop transcripts. */
const HOOK_TRANSCRIPT_BUDGET_RATIO = 0.7

function estimateHookTranscriptGroupTokens(group: Message[]): number {
  let tokens = 0
  for (const message of group) {
    if (message.type === 'assistant' || message.type === 'user') {
      tokens += roughTokenCountEstimationForMessage(message)
    } else {
      tokens += jsonStringify(message).length / 4
    }
  }
  return Math.ceil(tokens)
}

/**
 * Official zQY: drop earlier API-round groups from the tail-kept transcript
 * so Stop / SubagentStop evaluators stay within ~70% of the model budget.
 */
function truncateHookTranscript(
  messages: Message[],
  evaluatorModel: string,
): Message[] {
  const window = has1mContext(evaluatorModel)
    ? 1_000_000
    : MODEL_CONTEXT_WINDOW_DEFAULT
  const budget = Math.floor(window * HOOK_TRANSCRIPT_BUDGET_RATIO)
  if (tokenCountFromLastAPIResponse(messages) <= budget) {
    return messages
  }

  const groups = groupMessagesByApiRound(messages)
  let used = 0
  let keepFrom = groups.length
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!
    const groupTokens = estimateHookTranscriptGroupTokens(group)
    if (keepFrom < groups.length && used + groupTokens > budget) {
      break
    }
    used += groupTokens
    keepFrom = i
  }

  const kept = groups.slice(keepFrom).flat()
  const droppedMessages = messages.length - kept.length
  if (droppedMessages <= 0) {
    return messages
  }

  logForDebugging(
    `Hooks: truncated Stop transcript ${messages.length}→${kept.length} msgs (budget ${budget}, model ${evaluatorModel})`,
  )
  logEvent('tengu_hook_prompt_transcript_truncated', {
    droppedMessages,
    keptMessages: kept.length,
    budget,
    evaluatorModel:
      evaluatorModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return [
    createUserMessage({
      content: `[Earlier conversation truncated to fit the hook evaluator's context window — ${droppedMessages} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`,
    }),
    ...kept,
  ]
}

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  try {
    const isStopHook =
      hookEvent === 'Stop' || hookEvent === 'SubagentStop'
    const promptForModel = isStopHook
      ? `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: ${hook.prompt}`
      : hook.prompt
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(promptForModel, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })
    const evaluatorModel = hook.model ?? getSmallFastModel()
    const transcript =
      isStopHook && messages && messages.length > 0
        ? truncateHookTranscript(messages, evaluatorModel)
        : messages

    // Prepend conversation history if provided
    const messagesToQuery =
      transcript && transcript.length > 0
        ? [...transcript, userMessage]
        : [userMessage]

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const response = await queryModelWithoutStreaming({
        messages: messagesToQuery,
        systemPrompt: asSystemPrompt([
          isStopHook
            ? `You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.`
            : `You are evaluating a hook condition in Claude Code. Judge whether the user-provided condition is met.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<reason the condition is met>"}
- {"ok": false, "reason": "<reason the condition is not met>"}

Always include a "reason" field.`,
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools: [],
        signal: combinedSignal,
        options: {
          async getToolPermissionContext() {
            const appState = toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model: evaluatorModel,
          toolChoice: undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt',
          mcpTools: [],
          agentId: toolUseContext.agentId,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['ok', 'reason'],
              additionalProperties: false,
            },
          },
        },
      })

      cleanupSignal()

      if (response.isApiErrorMessage) {
        const apiError = extractTextContent(response.message.content).trim()
        logForDebugging(
          `Hooks: prompt-hook evaluator API error: ${apiError}`,
          { level: 'error' },
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Hook evaluator API error: ${apiError}`,
            stdout: '',
            exitCode: 1,
          }),
        }
      }

      // Extract text content from response
      const content = extractTextContent(response.message.content)

      // Update response length for spinner display
      toolUseContext.setResponseLength(length => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse)
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `[${hook.prompt}]: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: !isStopHook && hook.continueOnBlock !== true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(
        `Hooks: Prompt hook condition was met: ${parsed.data.reason}`,
      )
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
