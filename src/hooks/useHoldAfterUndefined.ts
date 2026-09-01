import { useEffect, useRef, useState } from 'react'

/**
 * Official 2.1.152 `Y14`: keep `value` visible for at least `holdMs` after it
 * becomes undefined so a completed thinking summary stays readable.
 */
export function useHoldAfterUndefined<T>(
  value: T | undefined,
  holdMs: number,
): T | undefined {
  const [held, setHeld] = useState(value)
  const lastDefinedAtRef = useRef(value !== undefined ? Date.now() : 0)

  useEffect(() => {
    if (value !== undefined) {
      lastDefinedAtRef.current = Date.now()
      setHeld(value)
      return
    }
    const remaining = holdMs - (Date.now() - lastDefinedAtRef.current)
    if (remaining <= 0) {
      setHeld(undefined)
      return
    }
    const timer = setTimeout(() => setHeld(undefined), remaining)
    return () => clearTimeout(timer)
  }, [value, holdMs])

  return held
}
