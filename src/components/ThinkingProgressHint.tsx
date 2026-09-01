import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { MessageResponse } from './MessageResponse.js'
import { ToolUseLoader } from './ToolUseLoader.js'

// Official 2.1.109 QgK rotating sequence — replaced the 2.1.108 five-stage
// static encouragement with a denser, rotating set of progress hints that
// starts after 1s and cycles new copy roughly every 6–15s.
const THINKING_ENCOURAGEMENT = [
  { afterMs: 1_000, text: 'Hmm…' },
  { afterMs: 6_000, text: 'This one needs a moment…' },
  { afterMs: 12_000, text: 'Working through it…' },
  { afterMs: 20_000, text: 'Untangling some thoughts…' },
  { afterMs: 28_000, text: 'Weighing a few approaches…' },
  { afterMs: 36_000, text: 'Consulting the rubber duck…' },
  { afterMs: 48_000, text: 'Cross-referencing seventeen theories…' },
  { afterMs: 60_000, text: 'Double-checking the double-checks…' },
  { afterMs: 80_000, text: 'Almost there…' },
  { afterMs: 108_000, text: 'Pacing in small circles…' },
  { afterMs: 120_000, text: 'Reticulating splines…' },
  { afterMs: 135_000, text: 'Hmm…?' },
  { afterMs: 150_000, text: 'Staring thoughtfully into the middle distance…' },
  { afterMs: 165_000, text: 'Still here, still at it…' },
]

type Props = {
  /** Official dgK only received isLoading; thinking came from wAK(). */
  isThinking: boolean
  isLoading: boolean
}

/**
 * Official 2.1.109 dgK: the extended-thinking indicator gained a rotating
 * progress hint. Renders an unresolved ToolUseLoader spinner plus a
 * "Thinking" header, with the current hint text on a ⎿ branch underneath.
 * The hint index steps through THINKING_ENCOURAGEMENT via per-step timeouts
 * (official QgK.afterMs scheduling); resets to -1 whenever thinking or
 * loading stops.
 */
export function ThinkingProgressHint({
  isThinking,
  isLoading,
}: Props): React.ReactNode {
  const [hintIndex, setHintIndex] = useState(-1)
  const hintIndexRef = useRef(hintIndex)
  hintIndexRef.current = hintIndex
  useEffect(() => {
    if (!isThinking || !isLoading) {
      if (hintIndexRef.current !== -1) setHintIndex(-1)
      return
    }
    const timers = THINKING_ENCOURAGEMENT.map((step, i) =>
      setTimeout(setHintIndex, step.afterMs, i),
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [isThinking, isLoading])
  if (hintIndex < 0 || !isThinking || !isLoading) return null
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box flexDirection="row">
        <ToolUseLoader
          shouldAnimate={true}
          isUnresolved={true}
          isError={false}
        />
        <Text>Thinking</Text>
      </Box>
      <MessageResponse>
        <Text dimColor>{THINKING_ENCOURAGEMENT[hintIndex]?.text}</Text>
      </MessageResponse>
    </Box>
  )
}
