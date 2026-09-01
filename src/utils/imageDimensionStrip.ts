import { APIError } from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { AssistantMessage, UserMessage } from '../types/message.js'

export type ImageDimensionErrorLocation = {
  messageIdx: number
  contentIdx: number
}

const DIMENSION_LIMIT_RE =
  /dimensions exceed max allowed size.*\d+ pixels/
const MESSAGE_IMAGE_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/

const STRIPPED_IMAGE_TEXT =
  '[Image removed: dimensions exceeded the 2000px limit for requests with many images]'

/**
 * Official 126 `WyK` — parse a 400 image-dimension error into the
 * `messages.N.content.M.image` path the API named.
 */
export function parseImageDimensionError(
  error: unknown,
): ImageDimensionErrorLocation | undefined {
  if (!(error instanceof APIError) || error.status !== 400) return
  if (!DIMENSION_LIMIT_RE.test(error.message)) return
  const match = error.message.match(MESSAGE_IMAGE_PATH_RE)
  if (!match) return
  return {
    messageIdx: Number(match[1]),
    contentIdx: Number(match[2]),
  }
}

/**
 * Official 126 `EX5` — replace the named image block with a text stub so
 * the next API attempt can proceed.
 */
export function stripOversizedImageFromMessages<
  T extends UserMessage | AssistantMessage,
>(messages: T[], loc: ImageDimensionErrorLocation): T[] {
  const msg = messages[loc.messageIdx]
  if (msg?.type !== 'user' || !Array.isArray(msg.message.content)) {
    return messages
  }
  const block = msg.message.content[loc.contentIdx]
  if (block?.type !== 'image') {
    return messages
  }
  const next: UserMessage = {
    ...msg,
    message: {
      ...msg.message,
      content: msg.message.content.map((part: ContentBlockParam, i) =>
        i === loc.contentIdx
          ? { type: 'text' as const, text: STRIPPED_IMAGE_TEXT }
          : part,
      ),
    },
  }
  return messages.map((m, i) => (i === loc.messageIdx ? (next as T) : m))
}
