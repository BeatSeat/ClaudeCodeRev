import { useCallback, useRef, useState } from 'react'
import type { PastedContent } from '../utils/config.js'

export type BufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  timestamp: number
}

export type UseInputBufferProps = {
  maxBufferSize: number
  debounceMs: number
}

export type UseInputBufferResult = {
  pushToBuffer: (
    text: string,
    cursorOffset: number,
    pastedContents?: Record<number, PastedContent>,
  ) => void
  undo: () => BufferEntry | undefined
  canUndo: boolean
  clearBuffer: () => void
}

/**
 * Prompt-input undo stack. Official 2.1.117 y$4:
 * entries are *previous* states (PromptInput pushes the old value before
 * applying a change). currentIndex points at the next state to restore,
 * so undo returns that entry then decrements — fixing "does nothing
 * immediately after typing" (canUndo was false at index 0) and
 * "skips a state" (116 returned index-1, jumping over the latest push).
 */
export function useInputBuffer({
  maxBufferSize,
  debounceMs,
}: UseInputBufferProps): UseInputBufferResult {
  const [buffer, setBuffer] = useState<BufferEntry[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const lastPushTime = useRef<number>(0)
  const pendingPush = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushToBuffer = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ) => {
      const now = Date.now()

      if (pendingPush.current) {
        clearTimeout(pendingPush.current)
        pendingPush.current = null
      }

      if (now - lastPushTime.current < debounceMs) {
        pendingPush.current = setTimeout(
          pushToBuffer,
          debounceMs,
          text,
          cursorOffset,
          pastedContents,
        )
        return
      }

      lastPushTime.current = now
      if (buffer[currentIndex]?.text === text) {
        return
      }

      setBuffer(prevBuffer => {
        const updatedBuffer = [
          ...prevBuffer.slice(0, currentIndex + 1),
          { text, cursorOffset, pastedContents, timestamp: now },
        ]
        if (updatedBuffer.length > maxBufferSize) {
          return updatedBuffer.slice(-maxBufferSize)
        }
        return updatedBuffer
      })

      setCurrentIndex(prev => Math.min(prev + 1, maxBufferSize - 1))
    },
    [debounceMs, maxBufferSize, currentIndex, buffer],
  )

  const undo = useCallback((): BufferEntry | undefined => {
    if (pendingPush.current) {
      clearTimeout(pendingPush.current)
      pendingPush.current = null
    }
    const entry = buffer[currentIndex]
    if (!entry) {
      return undefined
    }
    setCurrentIndex(currentIndex - 1)
    return entry
  }, [buffer, currentIndex])

  const clearBuffer = useCallback(() => {
    setBuffer([])
    setCurrentIndex(-1)
    lastPushTime.current = 0
    if (pendingPush.current) {
      clearTimeout(pendingPush.current)
      pendingPush.current = null
    }
  }, [])

  const canUndo = currentIndex >= 0 && buffer[currentIndex] !== undefined

  return {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer,
  }
}
