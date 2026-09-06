import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  fromName: string
  isTranscriptMode?: boolean
}

/** Official 2.1.178 `hOf` — strip C0/C1/bidi and cap the peer label at 64. */
function sanitizePeerName(raw: string): string {
  const cleaned = [...raw]
    .filter(ch => {
      const cp = ch.codePointAt(0) ?? 0
      if (cp < 32 || cp === 127) return false
      if (cp >= 128 && cp <= 159) return false
      if (
        (cp >= 8203 && cp <= 8207) ||
        (cp >= 8234 && cp <= 8238) ||
        (cp >= 8294 && cp <= 8297) ||
        cp === 65279
      ) {
        return false
      }
      return true
    })
    .join('')
    .trim()
  return (cleaned.length > 64 ? `${cleaned.slice(0, 64)}\u2026` : cleaned) || 'agent'
}

/**
 * Official 2.1.178 `fk4` — collapsed/transcript render for peer
 * (`origin.kind==="peer"` + `senderTaskId`) user text.
 */
export function UserPeerMessage({
  addMargin,
  param,
  fromName,
  isTranscriptMode,
}: Props): React.ReactNode {
  const label = sanitizePeerName(fromName)
  const expandShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const text = typeof param.text === 'string' ? param.text : ''
  const marginTop = addMargin ? 1 : 0

  if (!isTranscriptMode) {
    return (
      <Box marginTop={marginTop} width="100%">
        <Text dimColor>
          {figures.pointerSmall} Message from {label}{' '}
          <KeyboardShortcutHint
            shortcut={expandShortcut}
            action="expand"
            parens
          />
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={marginTop} width="100%">
      <Text dimColor>
        {figures.pointerSmall} Message from {label}
      </Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{text}</Text>
      </Box>
    </Box>
  )
}
