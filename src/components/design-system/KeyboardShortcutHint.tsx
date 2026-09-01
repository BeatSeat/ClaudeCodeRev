import React from 'react'
import Text from '../../ink/components/Text.js'
import {
  formatShortcutDisplay,
  type ShortcutFormatOptions,
} from '../../keybindings/format.js'

type Props = {
  /** Legacy pre-formatted key text (e.g. "ctrl+o", "Enter", "↑/↓") */
  shortcut?: string
  /** Key or chord list formatted by formatShortcutDisplay (official 2.1.92 n8) */
  chord?: string | readonly string[]
  /** Display options for `chord` (keyCase, arrowSep, style, …) */
  format?: ShortcutFormatOptions
  /** The action the key performs (e.g., "expand", "select", "navigate") */
  action: string
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean
}

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 *
 * @example
 * // Simple hint wrapped in dim Text
 * <Text dimColor><KeyboardShortcutHint shortcut="esc" action="cancel" /></Text>
 *
 * // Chord API (2.1.92): "↑↓ to navigate"
 * <Text dimColor>
 *   <KeyboardShortcutHint chord={['up', 'down']} format={{ arrowSep: '' }} action="navigate" />
 * </Text>
 *
 * // With parentheses: "(ctrl+o to expand)"
 * <Text dimColor><KeyboardShortcutHint shortcut="ctrl+o" action="expand" parens /></Text>
 *
 * // With bold shortcut: "Enter to confirm" (Enter is bold)
 * <Text dimColor><KeyboardShortcutHint shortcut="Enter" action="confirm" bold /></Text>
 *
 * // Multiple hints with middot separator - use Byline
 * <Text dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 */
export function KeyboardShortcutHint({
  shortcut,
  chord,
  format,
  action,
  parens = false,
  bold = false,
}: Props): React.ReactNode {
  const label =
    chord !== undefined ? formatShortcutDisplay(chord, format) : (shortcut ?? '')
  if (!label) {
    return null
  }
  const shortcutText = bold ? <Text bold>{label}</Text> : label

  if (parens) {
    return (
      <Text>
        ({shortcutText} to {action})
      </Text>
    )
  }
  return (
    <Text>
      {shortcutText} to {action}
    </Text>
  )
}
