import { randomUUID } from 'crypto'
import {
  getMainThreadAgentHooks,
  getRegisteredHooks,
  getSessionId,
} from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import { getHooksConfigFromSnapshot } from './hooksConfigSnapshot.js'

/** Official 2.1.152 aEz: target flushes per second. */
const FLUSH_HZ = 10
/** Official 2.1.152 wj9: max concurrent MessageDisplay hook runs. */
const MAX_IN_FLIGHT = 3
/** Official 2.1.152 Dj9: per-flush hook timeout. */
export const MESSAGE_DISPLAY_HOOK_TIMEOUT_MS = 10_000
/** Official 2.1.152 jj9 = 1000 / aEz. */
const FLUSH_INTERVAL_MS = 1000 / FLUSH_HZ

export type MessageDisplayFlushStats = {
  totalDurationMs: number
  maxDurationMs: number
  errorCount: number
  summaryEmitted: boolean
}

export type MessageDisplayFlushBuffer = {
  apiMessageId: string
  messageId: string
  turnId: string
  raw: string
  flushedOffset: number
  index: number
  output: string
  appendChain: Promise<void>
  lastFlushAt: number
  flushTimer: ReturnType<typeof setTimeout> | null
  inFlight: number
  abortController: AbortController
  finalized: boolean
  finalDispatched: boolean
  done: boolean
  abandoned: boolean
  stats: MessageDisplayFlushStats
}

export type MessageDisplayFlushEngine = {
  newTurn(): void
  begin(apiMessageId: string): void
  delta(text: string): void
  entryLanded(message: AssistantMessage): void
  finalize(): void
}

export type MessageDisplayFlushCallbacks = {
  getAppState: () => AppState
  onStreamingDisplay: (text: string | null) => void
  onMessageDisplay: (apiMessageId: string, output: string) => void
}

type MessageDisplayStreamEvent = {
  type?: string
  message?: { id?: string }
  delta?: { type?: string; text?: string }
}

function hooksForMessageDisplay(record: object | null | undefined): unknown[] {
  if (!record) return []
  const hooks = (record as Record<string, unknown[] | undefined>).MessageDisplay
  return hooks ?? []
}

function hasMessageDisplayHooks(appState: AppState | undefined): boolean {
  const sessionId = getSessionId()
  if (hooksForMessageDisplay(getHooksConfigFromSnapshot()).length > 0) {
    return true
  }
  if (hooksForMessageDisplay(getMainThreadAgentHooks()).length > 0) {
    return true
  }
  if (hooksForMessageDisplay(getRegisteredHooks()).length > 0) return true
  if (
    hooksForMessageDisplay(appState?.sessionHooks.get(sessionId)?.hooks)
      .length > 0
  ) {
    return true
  }
  return false
}

async function* runMessageDisplayHooks(
  params: {
    turnId: string
    messageId: string
    index: number
    final: boolean
    delta: string
  },
  getAppState: () => AppState,
  signal: AbortSignal,
): AsyncGenerator<{
  displayContent?: string
  message?: { type?: string; attachment?: { type?: string } }
}> {
  // Lazy import avoids hooks.ts → messages.ts → this file cycle.
  const { executeMessageDisplayHooks } = await import('../hooks.js')
  yield* executeMessageDisplayHooks(
    params,
    getAppState,
    signal,
    MESSAGE_DISPLAY_HOOK_TIMEOUT_MS,
  )
}

/**
 * Official 2.1.152 Jj9. Buffers raw assistant text, flushes on newline
 * (lastIndexOf("\\n")), runs MessageDisplay hooks, applies displayContent.
 */
export function createMessageDisplayFlushEngine({
  getAppState,
  onStreamingDisplay,
  onMessageDisplay,
}: MessageDisplayFlushCallbacks): MessageDisplayFlushEngine {
  let turnId = randomUUID()
  let current: MessageDisplayFlushBuffer | null = null

  function dispatch(buffer: MessageDisplayFlushBuffer): void {
    if (buffer.abandoned) return
    if (buffer.done) onMessageDisplay(buffer.apiMessageId, buffer.output)
    else onStreamingDisplay(buffer.output)
  }

  function runFlush(
    buffer: MessageDisplayFlushBuffer,
    index: number,
    final: boolean,
    delta: string,
  ): void {
    buffer.inFlight++
    const startedAt = Date.now()
    const hookPromise = (async () => {
      let display = delta
      try {
        for await (const result of runMessageDisplayHooks(
          {
            turnId: buffer.turnId,
            messageId: buffer.messageId,
            index,
            final,
            delta,
          },
          getAppState,
          buffer.abortController.signal,
        )) {
          const attachment =
            result.message &&
            typeof result.message === 'object' &&
            'type' in result.message &&
            result.message.type === 'attachment' &&
            'attachment' in result.message
              ? (
                  result.message as {
                    attachment?: { type?: string }
                  }
                ).attachment
              : undefined
          if (
            attachment?.type === 'hook_non_blocking_error' ||
            attachment?.type === 'hook_cancelled'
          ) {
            buffer.stats.errorCount++
          }
          if (result.displayContent !== undefined) {
            display = result.displayContent
          }
        }
      } catch (error) {
        buffer.stats.errorCount++
        logForDebugging(
          `MessageDisplay hook flush ${index} failed; displaying original delta: ${error instanceof Error ? error.message : String(error)}`,
          { level: 'error' },
        )
      } finally {
        const durationMs = Date.now() - startedAt
        buffer.stats.totalDurationMs += durationMs
        buffer.stats.maxDurationMs = Math.max(
          buffer.stats.maxDurationMs,
          durationMs,
        )
        buffer.inFlight--
        onFlushSettled(buffer)
      }
      return display
    })()
    buffer.appendChain = buffer.appendChain.then(async () => {
      buffer.output += await hookPromise
      dispatch(buffer)
    })
  }

  function onFlushSettled(buffer: MessageDisplayFlushBuffer): void {
    if (buffer.abandoned) return
    if (buffer.finalized) {
      if (!buffer.finalDispatched) flushNow(buffer, true)
      else if (buffer.inFlight === 0 && !buffer.stats.summaryEmitted) {
        buffer.stats.summaryEmitted = true
        logEvent('tengu_message_display_hooks', {
          flushCount: buffer.index,
          errorCount: buffer.stats.errorCount,
          totalDurationMs: buffer.stats.totalDurationMs,
          maxDurationMs: buffer.stats.maxDurationMs,
        })
      }
      return
    }
    scheduleFlush(buffer)
  }

  function flushNow(buffer: MessageDisplayFlushBuffer, final: boolean): void {
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer)
      buffer.flushTimer = null
    }
    if (buffer.inFlight >= MAX_IN_FLIGHT) return
    const end = final
      ? buffer.raw.length
      : buffer.raw.lastIndexOf('\n') + 1
    const delta = buffer.raw.slice(buffer.flushedOffset, end)
    if (!final && delta === '') return
    if (final) buffer.finalDispatched = true
    buffer.flushedOffset = end
    buffer.lastFlushAt = Date.now()
    const index = buffer.index
    buffer.index++
    runFlush(buffer, index, final, delta)
  }

  function scheduleFlush(buffer: MessageDisplayFlushBuffer): void {
    if (buffer.flushTimer !== null) return
    if (buffer.inFlight >= MAX_IN_FLIGHT) return
    if (buffer.raw.lastIndexOf('\n') + 1 <= buffer.flushedOffset) return
    const elapsed = Date.now() - buffer.lastFlushAt
    if (elapsed >= FLUSH_INTERVAL_MS) {
      flushNow(buffer, false)
      return
    }
    buffer.flushTimer = setTimeout(
      (queued: MessageDisplayFlushBuffer, flush: typeof flushNow) => {
        queued.flushTimer = null
        if (!queued.finalized && !queued.abandoned) flush(queued, false)
      },
      FLUSH_INTERVAL_MS - elapsed,
      buffer,
      flushNow,
    )
  }

  function abandon(buffer: MessageDisplayFlushBuffer): void {
    buffer.abandoned = true
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer)
      buffer.flushTimer = null
    }
    buffer.abortController.abort()
  }

  return {
    newTurn() {
      if (current && !current.finalized) abandon(current)
      current = null
      turnId = randomUUID()
    },
    begin(apiMessageId) {
      if (current && !current.finalized) abandon(current)
      if (!hasMessageDisplayHooks(getAppState())) {
        current = null
        onStreamingDisplay(null)
        return
      }
      current = {
        apiMessageId,
        messageId: randomUUID(),
        turnId,
        raw: '',
        flushedOffset: 0,
        index: 0,
        output: '',
        appendChain: Promise.resolve(),
        lastFlushAt: 0,
        flushTimer: null,
        inFlight: 0,
        abortController: new AbortController(),
        finalized: false,
        finalDispatched: false,
        done: false,
        abandoned: false,
        stats: {
          totalDurationMs: 0,
          maxDurationMs: 0,
          errorCount: 0,
          summaryEmitted: false,
        },
      }
      onStreamingDisplay('')
    },
    delta(text) {
      if (current === null || current.finalized) return
      current.raw += text
      scheduleFlush(current)
    },
    entryLanded(message) {
      const buffer = current
      if (buffer === null || buffer.apiMessageId !== message.message.id) return
      if (
        buffer.raw === '' ||
        !message.message.content.some(block => block.type === 'text')
      ) {
        return
      }
      buffer.done = true
      dispatch(buffer)
      onStreamingDisplay('')
    },
    finalize() {
      const buffer = current
      if (buffer === null) return
      buffer.finalized = true
      current = null
      onStreamingDisplay(null)
      if (buffer.raw === '' && buffer.index === 0) return
      buffer.done = true
      flushNow(buffer, true)
      dispatch(buffer)
    },
  }
}

/**
 * Official 2.1.152 Xj9. Apply MessageDisplay once to a completed assistant
 * message (SDK / QueryEngine path). First text block becomes displayContent;
 * later text blocks are cleared.
 */
export async function applyMessageDisplayToCompletedMessage(
  message: AssistantMessage,
  turnId: string,
  getAppState: () => AppState,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  if (!hasMessageDisplayHooks(getAppState())) {
    return message
  }
  const raw = message.message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
  if (raw === '') return message
  let displayContent: string | undefined
  try {
    for await (const result of runMessageDisplayHooks(
      {
        turnId,
        messageId: randomUUID(),
        index: 0,
        final: true,
        delta: raw,
      },
      getAppState,
      signal,
    )) {
      if (result.displayContent !== undefined) {
        displayContent = result.displayContent
      }
    }
  } catch (error) {
    logForDebugging(
      `MessageDisplay hook failed for completed message; emitting original text: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    return message
  }
  if (displayContent === undefined) return message
  let firstText = true
  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map(block => {
        if (block.type !== 'text') return block
        const text = firstText ? displayContent! : ''
        firstText = false
        return { ...block, text }
      }),
    },
  }
}

/**
 * Official 2.1.152 O9q. Drop displayedMessageContent entries whose assistant
 * message id is no longer in the live message list.
 */
export function pruneDisplayedMessageContent<
  T extends { displayedMessageContent: Record<string, string> },
>(state: T, messages: readonly Message[]): T {
  if (Object.keys(state.displayedMessageContent).length === 0) return state
  const liveIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'assistant') liveIds.add(message.message.id)
  }
  const next: Record<string, string> = {}
  let removed = false
  for (const [id, content] of Object.entries(state.displayedMessageContent)) {
    if (liveIds.has(id)) next[id] = content
    else removed = true
  }
  if (!removed) return state
  return { ...state, displayedMessageContent: next }
}

let getAppStateRef: (() => AppState) | null = null
let onStreamingDisplayRef: (text: string | null) => void = () => {}
let onMessageDisplayRef: (apiMessageId: string, output: string) => void =
  () => {}
let boundEngine: MessageDisplayFlushEngine | null = null

export function bindMessageDisplayFlush(opts: {
  getAppState: () => AppState
  onStreamingDisplay?: (text: string | null) => void
  onMessageDisplay?: (apiMessageId: string, output: string) => void
}): MessageDisplayFlushEngine {
  getAppStateRef = opts.getAppState
  if (opts.onStreamingDisplay) {
    onStreamingDisplayRef = opts.onStreamingDisplay
  }
  if (opts.onMessageDisplay) {
    onMessageDisplayRef = opts.onMessageDisplay
  }
  if (boundEngine === null) {
    boundEngine = createMessageDisplayFlushEngine({
      getAppState: () => {
        if (!getAppStateRef) {
          throw new Error('MessageDisplay flush getAppState is not bound')
        }
        return getAppStateRef()
      },
      onStreamingDisplay: text => onStreamingDisplayRef(text),
      onMessageDisplay: (apiMessageId, output) =>
        onMessageDisplayRef(apiMessageId, output),
    })
  }
  return boundEngine
}

export function getBoundMessageDisplayFlush(): MessageDisplayFlushEngine | null {
  return boundEngine
}

/** Official 2.1.152 displayTransform call sites (begin / delta / finalize / entryLanded). */
export function feedMessageDisplayFlush(message: {
  type: string
  event?: MessageDisplayStreamEvent
  message?: AssistantMessage['message']
}): void {
  const engine = boundEngine
  if (!engine) return
  if (message.type === 'assistant' && message.message) {
    engine.entryLanded(message as AssistantMessage)
    return
  }
  if (message.type !== 'stream_event') return
  const event = message.event
  if (!event) return
  if (event.type === 'message_start' && event.message?.id) {
    engine.begin(event.message.id)
    return
  }
  if (event.type === 'message_stop') {
    engine.finalize()
    return
  }
  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string'
  ) {
    engine.delta(event.delta.text)
  }
}
