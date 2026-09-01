import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AssistantMessage } from 'src/types/message.js'
import { isEnvTruthy } from '../envUtils.js'
import { jsonStringify } from '../slowOperations.js'
import { logOTelEvent } from './events.js'

/** Official 2.1.111 `rb4`. Truncate raw API bodies at 60KB. */
const RAW_API_BODY_LIMIT = 61_440

type ThinkingLike = {
  type: string
  thinking?: string
  data?: string
}

/** Official 2.1.111 `ob4`. */
export function isRawApiBodyLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_RAW_API_BODIES)
}

/** Official 2.1.111 `ab4`. Emit a truncated JSON body as an OTEL log event. */
function emitRawApiBody(
  eventName: string,
  body: unknown,
  extra?: { [key: string]: string | undefined },
): void {
  const serialized = jsonStringify(body)
  const truncated = serialized.length > RAW_API_BODY_LIMIT
  void logOTelEvent(eventName, {
    body: truncated
      ? serialized.slice(0, RAW_API_BODY_LIMIT) +
        '\n\n[TRUNCATED - Content exceeds 60KB limit]'
      : serialized,
    body_length: String(serialized.length),
    ...(truncated && { body_truncated: 'true' }),
    ...extra,
  })
}

/** Official 2.1.111 `sb4`. Redact thinking / redacted_thinking blocks. */
function redactThinkingBlocks<T extends ThinkingLike>(blocks: T[]): T[] {
  return blocks.map(block => {
    if (block.type === 'thinking') {
      return { ...block, thinking: '<REDACTED>' }
    }
    if (block.type === 'redacted_thinking') {
      return { ...block, data: '<REDACTED>' }
    }
    return block
  })
}

/** Official 2.1.111 `f0z`. Redact assistant thinking in the outbound request. */
function redactRequestThinking(
  params: BetaMessageStreamParams,
): BetaMessageStreamParams {
  return {
    ...params,
    messages: params.messages.map(message =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? {
            ...message,
            content: redactThinkingBlocks(
              message.content as ThinkingLike[],
            ) as typeof message.content,
          }
        : message,
    ),
  }
}

/** Official 2.1.111 `Ox8`. */
export function logRawApiRequestBody(
  params: BetaMessageStreamParams,
  querySource?: string,
): void {
  if (!isRawApiBodyLoggingEnabled()) return
  emitRawApiBody('api_request_body', redactRequestThinking(params), {
    model: params.model,
    query_source: querySource,
  })
}

/** Official 2.1.111 `tb4`. */
export function logRawApiResponseBody(
  messages: AssistantMessage[] | undefined,
  meta: { model: string; querySource: string; requestId?: string | null },
): void {
  if (!isRawApiBodyLoggingEnabled() || !messages || messages.length === 0) {
    return
  }
  const last = messages.at(-1)
  if (!last) return
  const merged = messages.flatMap(m => m.message.content)
  emitRawApiBody(
    'api_response_body',
    {
      ...last.message,
      content: redactThinkingBlocks(merged as ThinkingLike[]),
    },
    {
      model: meta.model,
      query_source: meta.querySource,
      request_id: meta.requestId ?? undefined,
    },
  )
}
