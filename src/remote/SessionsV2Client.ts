/**
 * Official 2.1.118 N06 SessionsV2Client — SSE client for
 * /v1/code/sessions/{id}/events/stream so JWT refresh blips reattach
 * instead of archiving the session.
 */
import { randomUUID } from 'crypto'
import { getOauthConfig } from '../constants/oauth.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlCancelRequest,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage, toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getProxyFetchOptions } from '../utils/proxy.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../utils/userAgent.js'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 5
const LIVENESS_TIMEOUT_MS = 45_000
const CONNECT_TIMEOUT_MS = 30_000
const DRIFT_CHECK_INTERVAL_MS = 5_000
const PERMANENT_HTTP_STATUSES = new Set([401, 403, 404])

function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name:
      featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code:
      errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

function featureBad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_bad', {
    feature_name:
      featureName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code:
      errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

type SessionsV2State = 'idle' | 'connecting' | 'connected' | 'closed'

type SessionsV2Message =
  | SDKMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKControlCancelRequest

export type SessionsV2ClientCallbacks = {
  onMessage: (message: SessionsV2Message) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onReconnecting?: () => void
  onCatchUpTruncated?: () => void
}

function isSessionsPayload(value: unknown): value is SessionsV2Message {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  )
}

function splitSseFrames(buffer: string): {
  frames: Array<{ event?: string; id?: string; data?: string }>
  remaining: string
} {
  const frames: Array<{ event?: string; id?: string; data?: string }> = []
  const parts = buffer.split('\n\n')
  const remaining = parts.pop() ?? ''
  for (const block of parts) {
    let event: string | undefined
    let id: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    frames.push({ event, id, data: dataLines.join('\n') || undefined })
  }
  return { frames, remaining }
}

export class SessionsV2Client {
  sessionId: string
  orgUuid: string
  getAccessToken: () => string
  callbacks: SessionsV2ClientCallbacks
  state: SessionsV2State = 'idle'
  abortController: AbortController | null = null
  reconnectAttempts = 0
  exhaustedBudget = false
  reconnectTimer: ReturnType<typeof setTimeout> | null = null
  livenessTimer: ReturnType<typeof setTimeout> | null = null
  driftTimer: ReturnType<typeof setInterval> | null = null
  lastDriftCheck = 0
  lastSequenceNum = 0

  constructor(
    sessionId: string,
    orgUuid: string,
    getAccessToken: () => string,
    callbacks: SessionsV2ClientCallbacks,
  ) {
    this.sessionId = sessionId
    this.orgUuid = orgUuid
    this.getAccessToken = getAccessToken
    this.callbacks = callbacks
  }

  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') {
      logForDebugging('[SessionsV2Client] Already connecting/connected')
      return
    }
    this.state = 'connecting'
    const url = new URL(
      `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${this.sessionId}/events/stream`,
    )
    if (this.lastSequenceNum > 0) {
      url.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    }
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      Accept: 'text/event-stream',
    }
    if (this.lastSequenceNum > 0) {
      headers['Last-Event-ID'] = String(this.lastSequenceNum)
    }
    logForDebugging(
      `[SessionsV2Client] Connecting to ${url.href} (from_sequence_num=${this.lastSequenceNum})`,
    )
    this.abortController = new AbortController()
    void this.readStream(url, headers, this.abortController)
  }

  async readStream(
    url: URL,
    headers: Record<string, string>,
    abort: AbortController,
  ): Promise<void> {
    let response: Response
    let timedOut = false
    const connectTimer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, CONNECT_TIMEOUT_MS)
    try {
      response = await fetch(url.href, {
        method: 'GET',
        headers,
        signal: abort.signal,
        ...getProxyFetchOptions({ url: url.href }),
      })
      clearTimeout(connectTimer)
    } catch (err) {
      clearTimeout(connectTimer)
      if (timedOut) {
        logForDebugging(
          `[SessionsV2Client] Connect timed out after ${CONNECT_TIMEOUT_MS}ms, reconnecting`,
          { level: 'error' },
        )
        featureSad('remote_connect', 'remote_connect_timeout')
        this.handleStreamEnd()
        return
      }
      if (abort.signal.aborted) return
      logForDebugging(`[SessionsV2Client] Connect error: ${errorMessage(err)}`, {
        level: 'error',
      })
      featureSad('remote_connect', 'remote_connect_request_failed')
      this.callbacks.onError?.(toError(err))
      this.handleStreamEnd()
      return
    }
    if (!response.ok || !response.body) {
      logForDebugging(
        `[SessionsV2Client] HTTP ${response.status} on SSE connect`,
        { level: 'error' },
      )
      void response.body?.cancel()
      if (PERMANENT_HTTP_STATUSES.has(response.status)) {
        this.state = 'closed'
        this.callbacks.onClose?.()
        return
      }
      this.handleStreamEnd()
      return
    }
    this.state = 'connected'
    this.reconnectAttempts = 0
    this.resetLivenessTimer()
    this.startDriftWatch()
    logForDebugging('[SessionsV2Client] Connected')
    this.callbacks.onConnected?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { frames, remaining } = splitSseFrames(buffer)
        buffer = remaining
        for (const frame of frames) {
          this.resetLivenessTimer()
          if (frame.event && frame.data) {
            this.handleFrame(frame.event, frame.id, frame.data)
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return
      logForDebugging(
        `[SessionsV2Client] Stream read error: ${errorMessage(err)}`,
        { level: 'error' },
      )
    } finally {
      reader.releaseLock()
    }
    if (!abort.signal.aborted) {
      logForDebugging('[SessionsV2Client] Stream ended')
      this.handleStreamEnd()
    }
  }

  handleFrame(event: string, id: string | undefined, data: string): void {
    let parsed: unknown
    try {
      parsed = jsonParse(data)
    } catch (err) {
      logError(
        new Error(
          `[SessionsV2Client] Failed to parse ${event} frame: ${errorMessage(err)}`,
        ),
      )
      return
    }
    switch (event) {
      case 'client_event': {
        const payload = (parsed as { payload?: unknown; sequence_num?: number; event_type?: string })
        const seq = parseInt(id ?? String(payload.sequence_num), 10)
        if (!Number.isNaN(seq) && seq > this.lastSequenceNum) {
          this.lastSequenceNum = seq
        }
        if (isSessionsPayload(payload.payload)) {
          this.callbacks.onMessage(payload.payload)
        } else {
          logForDebugging(
            `[SessionsV2Client] Dropping client_event with no payload.type (event_type=${payload.event_type})`,
          )
        }
        return
      }
      case 'ephemeral_event': {
        const payload = (parsed as { payload?: unknown }).payload
        if (isSessionsPayload(payload)) this.callbacks.onMessage(payload)
        return
      }
      case 'catch_up_truncated':
        logForDebugging(
          '[SessionsV2Client] catch_up_truncated — transcript gap',
        )
        featureSad('remote_connect', 'remote_catch_up_truncated')
        this.callbacks.onCatchUpTruncated?.()
        return
      case 'session_update':
      case 'delivery_update':
        logForDebugging(`[SessionsV2Client] Ignoring ${event} frame`)
        return
      default:
        logForDebugging(`[SessionsV2Client] Unknown SSE event type '${event}'`, {
          level: 'warn',
        })
    }
  }

  handleStreamEnd(): void {
    this.clearLivenessTimer()
    this.clearDriftWatch()
    if (this.state === 'closed') return
    this.abortController = null
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logForDebugging(
        `[SessionsV2Client] Reconnect budget exhausted (${MAX_RECONNECT_ATTEMPTS}), closing`,
      )
      featureBad('remote_connect', 'remote_connect_reconnect_exhausted')
      this.state = 'closed'
      this.exhaustedBudget = true
      this.callbacks.onClose?.()
      return
    }
    this.reconnectAttempts++
    this.state = 'idle'
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    )
    logForDebugging(
      `[SessionsV2Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, from_sequence_num=${this.lastSequenceNum})`,
    )
    this.callbacks.onReconnecting?.()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  onLivenessTimeout = (): void => {
    this.livenessTimer = null
    logForDebugging('[SessionsV2Client] Liveness timeout, reconnecting', {
      level: 'warn',
    })
    this.abortController?.abort()
    this.abortController = null
    this.handleStreamEnd()
  }

  resetLivenessTimer(): void {
    this.clearLivenessTimer()
    this.livenessTimer = setTimeout(this.onLivenessTimeout, LIVENESS_TIMEOUT_MS)
  }

  clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  /**
   * Official 2.1.166: wall-clock drift watch — a tick gap larger than twice
   * the interval means the process was suspended; reconnect so the stream
   * doesn't sit half-dead after resume.
   */
  startDriftWatch(): void {
    this.clearDriftWatch()
    this.lastDriftCheck = Date.now()
    this.driftTimer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - this.lastDriftCheck
      this.lastDriftCheck = now
      if (elapsed > DRIFT_CHECK_INTERVAL_MS * 2 && this.state === 'connected') {
        logForDebugging(
          `[SessionsV2Client] Wall-clock drift ${elapsed}ms — reconnecting after suspend`,
        )
        this.reconnect()
      }
    }, DRIFT_CHECK_INTERVAL_MS)
    this.driftTimer.unref?.()
  }

  clearDriftWatch(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer)
      this.driftTimer = null
    }
  }

  async sendEvent(
    payload: Record<string, unknown>,
  ): Promise<{ sequence_num: number } | null> {
    if (this.state === 'closed') {
      logForDebugging('[SessionsV2Client] Cannot send: closed', { level: 'warn' })
      return null
    }
    const url = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${this.sessionId}/events`
    const body = {
      session_id: this.sessionId,
      events: [{ payload }],
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: jsonStringify(body),
        signal: AbortSignal.timeout(30_000),
        ...getProxyFetchOptions({ url }),
      })
      if (!response.ok) {
        void response.body?.cancel()
        logForDebugging(
          `[SessionsV2Client] POST /events returned ${response.status}`,
          { level: 'warn' },
        )
        return null
      }
      const json = (await response.json()) as {
        results?: Array<{ sequence_num?: number }>
      }
      const seq = parseInt(String(json.results?.[0]?.sequence_num), 10)
      return { sequence_num: Number.isNaN(seq) ? 0 : seq }
    } catch (err) {
      logForDebugging(
        `[SessionsV2Client] POST /events failed: ${errorMessage(err)}`,
        { level: 'warn' },
      )
      return null
    }
  }

  sendControlResponse(message: SDKControlResponse): void {
    logForDebugging('[SessionsV2Client] Sending control_response')
    void this.sendEvent({ ...message, uuid: randomUUID() })
  }

  sendControlRequest(request: SDKControlRequestInner): string | null {
    if (this.state === 'closed') {
      logForDebugging(
        '[SessionsV2Client] Cannot send control_request: closed',
        { level: 'warn' },
      )
      return null
    }
    const requestId = randomUUID()
    const event = {
      type: 'control_request',
      request_id: requestId,
      request,
      uuid: randomUUID(),
    }
    logForDebugging(
      `[SessionsV2Client] Sending control_request: ${request.subtype}`,
    )
    void this.sendEvent(event)
    return requestId
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  close(): void {
    logForDebugging('[SessionsV2Client] Closing')
    this.state = 'closed'
    this.exhaustedBudget = false
    this.clearLivenessTimer()
    this.clearDriftWatch()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.abortController?.abort()
    this.abortController = null
  }

  reconnect(): void {
    logForDebugging('[SessionsV2Client] Force reconnect')
    this.reconnectAttempts = 0
    this.exhaustedBudget = false
    this.clearLivenessTimer()
    this.clearDriftWatch()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.abortController?.abort()
    this.abortController = null
    this.state = 'idle'
    void this.connect()
  }

  /**
   * Official 2.1.166: when the reconnect budget was exhausted (brief backend
   * disruption) the client used to be stuck closed; a user action (send) can
   * now revive the stream.
   */
  reviveAfterExhaustion(): boolean {
    if (this.state !== 'closed' || !this.exhaustedBudget) return false
    featureSad('remote_connect', 'remote_connect_revived_by_user_send')
    this.reconnect()
    return true
  }

  authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getAccessToken()}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-organization-uuid': this.orgUuid,
      'User-Agent': getClaudeCodeUserAgent(),
    }
  }
}
