import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { TEARDROP_ASTERISK } from '../../constants/figures.js'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { isXtermJs } from '../../ink/terminal.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { hueToRgb, quantizeHue, toRGBColor } from '../Spinner/utils.js'

const SWEEP_DURATION_MS = 1500
const SWEEP_COUNT = 2
const TOTAL_ANIMATION_MS = SWEEP_DURATION_MS * SWEEP_COUNT
const SETTLED_GREY = toRGBColor({ r: 153, g: 153, b: 153 })

export function AnimatedAsterisk({
  char = TEARDROP_ASTERISK,
}: {
  char?: string
}): React.ReactNode {
  // Read prefersReducedMotion once at mount — no useSettings() subscription,
  // since that would re-render whenever settings change.
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [done, setDone] = useState(reducedMotion)
  // useAnimationFrame's clock is shared — capture our start offset so the
  // sweep always begins at hue 0 regardless of when we mount.
  const startTimeRef = useRef<number | null>(null)
  // Wire the ref so useAnimationFrame's viewport-pause kicks in: if the
  // user submits a message before the sweep finishes, the clock stops
  // automatically once this row enters scrollback (prevents flicker).
  const [ref, time] = useAnimationFrame(done ? null : 50)

  useEffect(() => {
    if (done) return
    const t = setTimeout(setDone, TOTAL_ANIMATION_MS, true)
    return () => clearTimeout(t)
  }, [done])

  if (done) {
    return (
      <Box ref={ref}>
        <Text color={SETTLED_GREY}>{char}</Text>
      </Box>
    )
  }

  if (startTimeRef.current === null) {
    startTimeRef.current = time
  }
  const elapsed = time - startTimeRef.current
  const rawHue = ((elapsed / SWEEP_DURATION_MS) * 360) % 360
  // Official 2.1.154 `PL()?h78(f):f` — cap distinct spinner colors in VS Code.
  const hue = isXtermJs() ? quantizeHue(rawHue) : rawHue

  return (
    <Box ref={ref}>
      <Text color={toRGBColor(hueToRgb(hue))}>{char}</Text>
    </Box>
  )
}
