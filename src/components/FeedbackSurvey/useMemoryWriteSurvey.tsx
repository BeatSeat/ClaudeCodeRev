/**
 * useMemoryWriteSurvey — the React state machine for the memory-write-survey
 * confirmation dialog (official 2.1.120 bundle hook `LZ4`).
 *
 * Reads the queued memory writes from AppState (`memoryWriteQueue`, populated
 * by the Write tool), shows the top one when idle (no active prompt, no other
 * survey), applies the throttle/timeout config, lazily fetches the LLM
 * summary, and closes on Keep / Undo / auto-hide.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type MemoryWriteRecord,
  isMemoryWriteSurveyGateEnabled,
  lineCountForRecord,
  logMemoryWriteSurveyEvent,
  removeMemoryWriteRecord,
  readMemoryWriteSurveyConfig,
  summarizeMemoryWrite,
  undoMemoryWrite,
} from './memoryWriteSurvey.js'
import { useSetAppState, useAppState } from '../../state/AppState.js'

/** Countdown seconds at which the "auto-hides in Ns" label first appears. */
const COUNTDOWN_DISPLAY_THRESHOLD_SEC = 5

export type MemoryWriteSurveyState = {
  state: 'closed' | 'open'
  record: MemoryWriteRecord | null
  summary: string | null
  lineCount: number
  summaryLineThreshold: number
  countdownSec: number | null
  handleOutcome: (outcome: 'approve' | 'reject' | 'timeout') => void
}

export function useMemoryWriteSurvey(
  hasActivePrompt: boolean,
  { otherSurveyActive = false }: { otherSurveyActive?: boolean } = {},
): MemoryWriteSurveyState {
  const setAppState = useSetAppState()

  // Active (open) survey. `null` means closed.
  const [active, setActive] = useState<MemoryWriteRecord | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [countdownSec, setCountdownSec] = useState<number | null>(null)
  const [lineCount, setLineCount] = useState(0)
  // Re-runs the show effect after a throttle wait elapses.
  const [tick, setTick] = useState(0)

  // One-time config snapshot (bundle: `useState(BH6)` / `useState(FH6)`).
  const [config] = useState(() => readMemoryWriteSurveyConfig())
  // Bundle `FH6()` — an always-false dev override kept for structural parity.
  const devOverride = false

  const lastAppearanceAtRef = useRef(0)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  )
  const abortControllerRef = useRef<AbortController | null>(null)

  // The queue head is read from the store each render (stable reference — the
  // effect below re-runs whenever this changes).
  const queueHead = useAppState(s => s.memoryWriteQueue?.[0] ?? null)
  const queueDepth = useAppState(s => s.memoryWriteQueue?.length ?? 0)

  const removeFromQueue = useCallback(
    (id: string) => {
      setAppState(prev => {
        const records = prev.memoryWriteQueue ?? []
        const next = removeMemoryWriteRecord(records, id)
        return next === records ? prev : { ...prev, memoryWriteQueue: next }
      })
    },
    [setAppState],
  )

  const clearActive = useCallback(
    (id: string) => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      setActive(null)
      setSummary(null)
      setCountdownSec(null)
      lastAppearanceAtRef.current = Date.now()
      removeFromQueue(id)
    },
    [removeFromQueue],
  )

  const handleOutcome = useCallback(
    (outcome: 'approve' | 'reject' | 'timeout') => {
      if (!active) {
        return
      }
      // Bundle `v`: emit the outcome value itself, undo only on "reject".
      logMemoryWriteSurveyEvent(outcome, active, {
        lineCount,
        wasSummarized: summary !== null,
        queueDepth,
      })
      if (outcome === 'reject') {
        void undoMemoryWrite(active)
      }
      clearActive(active.id)
    },
    [active, summary, lineCount, queueDepth, clearActive],
  )

  // The timeout interval fires from a closure; use the latest handler.
  const handleOutcomeRef = useRef(handleOutcome)
  handleOutcomeRef.current = handleOutcome

  useEffect(() => {
    const queued = queueHead
    // Don't open if one is already open, a prompt is active, or another
    // survey is on screen.
    if (active || !queued || hasActivePrompt || otherSurveyActive) {
      return
    }
    // Gate re-check at show time (bundle: `if(!UH6()){ drop; return }`).
    if (!devOverride && !isMemoryWriteSurveyGateEnabled()) {
      removeFromQueue(queued.id)
      return
    }
    // Throttle: if the last appearance was within `throttleMs`, wait for the
    // remainder, then re-run this effect rather than showing immediately.
    const sinceLast = Date.now() - lastAppearanceAtRef.current
    if (!devOverride && sinceLast < config.throttleMs) {
      const waitMs = config.throttleMs - sinceLast
      const timer = setTimeout(() => setTick(n => n + 1), waitMs)
      return () => clearTimeout(timer)
    }

    const recordLineCount = lineCountForRecord(queued)
    setActive(queued)
    setLineCount(recordLineCount)
    logMemoryWriteSurveyEvent('appeared', queued, {
      lineCount: recordLineCount,
      wasSummarized: false,
      queueDepth,
    })

    const hidesAt = Date.now() + config.timeoutMs
    countdownIntervalRef.current = setInterval(() => {
      const remainingSec = Math.ceil((hidesAt - Date.now()) / 1000)
      if (remainingSec <= 0) {
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current)
          countdownIntervalRef.current = null
        }
        // Bundle: auto-hide resolves as a "timeout" outcome (no undo).
        handleOutcomeRef.current('timeout')
        return
      }
      // Only surface the countdown during the final threshold seconds.
      if (remainingSec <= COUNTDOWN_DISPLAY_THRESHOLD_SEC) {
        setCountdownSec(prev => (prev === remainingSec ? prev : remainingSec))
      }
    }, 1000)

    // Fetch the one-sentence summary only for long writes.
    if (recordLineCount > config.summaryLineThreshold) {
      const controller = new AbortController()
      abortControllerRef.current = controller
      void summarizeMemoryWrite(queued, controller.signal).then(value => {
        if (!controller.signal.aborted && value) {
          setSummary(value)
        }
      })
    }
  }, [
    queueHead,
    queueDepth,
    active,
    hasActivePrompt,
    otherSurveyActive,
    config,
    devOverride,
    removeFromQueue,
    tick,
  ])

  // Cleanup on unmount.
  useEffect(
    () => () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
      }
      abortControllerRef.current?.abort()
    },
    [],
  )

  if (!active) {
    return {
      state: 'closed',
      record: null,
      summary: null,
      lineCount: 0,
      summaryLineThreshold: config.summaryLineThreshold,
      countdownSec: null,
      handleOutcome: () => {},
    }
  }
  return {
    state: 'open',
    record: active,
    summary,
    lineCount,
    summaryLineThreshold: config.summaryLineThreshold,
    countdownSec,
    handleOutcome,
  }
}
