/**
 * Background-session classifier job state (official 2.1.187 `HVn` surface).
 *
 * Full classify/bridge-write pipeline is not restored here; exports match the
 * bundle surface used by MCP end-turn (`qce` → `markTurnAborted`) and related
 * call sites. Prefer a live stub over a dead path when the deep subsystem
 * is absent.
 */

import { basename } from 'path'
import { getSessionId } from '../bootstrap/state.js'

export type ClassifierJobState = {
  prevState: string
  prevStateSince: number
  accumulatedOutputs: Record<string, unknown>
  lastClassifyAt: number
  capturedIntent: string
  inFlight: unknown
  nameInFlight: boolean
  dispatchEmitted: boolean
  latestAsk: string
  kicked: boolean
  lastMsgCount: number
  permissionBridgeSubscribed: boolean
  bridgeWriteChain: Promise<void>
  lastEmittedDetail: string
  lastResult: unknown
}

/** Official 2.1.187 `h8p`. */
export function createClassifierJobState(): ClassifierJobState {
  return {
    prevState: '',
    prevStateSince: Date.now(),
    accumulatedOutputs: {},
    lastClassifyAt: 0,
    capturedIntent: '',
    inFlight: null,
    nameInFlight: false,
    dispatchEmitted: false,
    latestAsk: '',
    kicked: false,
    lastMsgCount: 0,
    permissionBridgeSubscribed: false,
    bridgeWriteChain: Promise.resolve(),
    lastEmittedDetail: '',
    lastResult: null,
  }
}

/** Official 2.1.187 `ERe` — process-local singleton job state. */
let classifierJobState: ClassifierJobState | null | undefined

export function getOrCreateClassifierJobState(): ClassifierJobState | null {
  if (classifierJobState === undefined) {
    classifierJobState = createClassifierJobState()
  }
  return classifierJobState
}

/** Official 2.1.187 `eE` — job dir basename or truncated session id. */
export function getClassifierSessionKey(): string {
  const jobDir = process.env.CLAUDE_JOB_DIR
  if (jobDir) return basename(jobDir)
  return getSessionId().slice(0, 8)
}

/**
 * Official 2.1.187 `T8p` — mark the bg classifier turn idle after an aborted
 * / MCP end-turn. Full bridge write + link scan is not restored; clear
 * `kicked` so the next `markTurnActive` can fire.
 */
export function markTurnAborted(
  state: ClassifierJobState,
  _sessionKey: string,
): void {
  state.kicked = false
}

/**
 * Official 2.1.187 `A8p` stub — latch that a turn is active.
 */
export function markTurnActive(
  state: ClassifierJobState,
  _sessionKey: string,
  _ask?: string,
): void {
  if (state.kicked) return
  state.kicked = true
}

/**
 * Official 2.1.187 `v8p` stub — API failure recording (no-op without bridge).
 */
export async function markApiFailure(
  _state: ClassifierJobState,
  _sessionKey: string,
  _error: unknown,
  _detail: string,
): Promise<void> {
  // Deep bridge write path not restored.
}

/** Used by TEMPLATES stopHooks path (pre-existing stub surface). */
export async function classifyAndWriteState(
  _jobDir: string,
  _assistantMessages: unknown[],
): Promise<void> {
  // Full fqt classifier not restored in this tree.
}
