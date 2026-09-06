import React, { useMemo } from 'react'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { Box, Text } from '../ink.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import { isEnvTruthy } from '../utils/envUtils.js'

type Props = {
  query: string
  placeholder?: string
  isFocused: boolean
  isTerminalFocused: boolean
  prefix?: string
  width?: number | string
  cursorOffset?: number
  borderless?: boolean
  /** Official 176 `hk` `cursorChar`. */
  cursorChar?: string
}

/**
 * Official 176 `pt` / `uS6` without `sLH()` (DECSTBM porch). Accessibility
 * or `CLAUDE_CODE_NATIVE_CURSOR` / `tengu_native_cursor` selects native
 * cursor and hides the inverse cell.
 */
function shouldUseNativeCursor(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_ACCESSIBILITY)) return true
  if (isEnvTruthy(process.env.CLAUDE_CODE_NATIVE_CURSOR)) return true
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_native_cursor', false)
}

export function SearchBox({
  query,
  placeholder = 'Search…',
  isFocused,
  isTerminalFocused,
  prefix = '⌕',
  width,
  cursorOffset,
  borderless = false,
  cursorChar,
}: Props): React.ReactNode {
  const offset = cursorOffset ?? query.length
  const padX = borderless ? 0 : 2
  const padY = borderless ? 0 : 1
  const nativeCursor = useMemo(shouldUseNativeCursor, [])
  // Official 176 `h`: hide native cursor on alt-screen full repaint (not bg).
  const hideNativeOnAltScreen =
    isEnvTruthy(process.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT) &&
    process.env.CLAUDE_CODE_SESSION_KIND !== 'bg'
  const cursorRef = useDeclaredCursor({
    line: padY,
    column: padX + prefix.length + 1 + offset,
    active: isFocused,
    visible: cursorChar === undefined && !hideNativeOnAltScreen,
  })
  // Official 176 `I`. Inverse cell unless native cursor owns the caret.
  const showInverseCursor =
    isTerminalFocused &&
    !(nativeCursor && !hideNativeOnAltScreen && cursorChar === undefined)

  return (
    <Box
      ref={cursorRef}
      flexShrink={0}
      borderStyle={borderless ? undefined : 'round'}
      borderColor={isFocused ? 'suggestion' : undefined}
      borderDimColor={!isFocused}
      paddingX={borderless ? 0 : 1}
      width={width}
    >
      <Text dimColor={!isFocused}>
        {prefix}{' '}
        {isFocused ? (
          <>
            {query ? (
              showInverseCursor ? (
                <>
                  <Text>{query.slice(0, offset)}</Text>
                  {cursorChar !== undefined ? (
                    <Text>{cursorChar}</Text>
                  ) : (
                    <Text inverse>
                      {offset < query.length ? query[offset] : ' '}
                    </Text>
                  )}
                  {offset < query.length && (
                    <Text>{query.slice(offset + 1)}</Text>
                  )}
                </>
              ) : (
                <Text>{query}</Text>
              )
            ) : showInverseCursor ? (
              <>
                {cursorChar ?? <Text inverse>{placeholder.charAt(0)}</Text>}
                <Text dimColor>{cursorChar ? placeholder : placeholder.slice(1)}</Text>
              </>
            ) : (
              <Text dimColor>{placeholder}</Text>
            )}
          </>
        ) : query ? (
          <Text>{query}</Text>
        ) : (
          <Text>{placeholder}</Text>
        )}
      </Text>
    </Box>
  )
}
