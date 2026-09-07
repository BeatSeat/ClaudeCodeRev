import figures from 'figures'
import type { ReactNode } from 'react'
import React, { useState } from 'react'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { Box, Text } from '../../ink.js'

type ListItemProps = {
  /**
   * Whether this item is currently focused (keyboard selection).
   * Shows the pointer indicator (❯) when true.
   */
  isFocused: boolean

  /**
   * Whether this item is selected (chosen/checked).
   * Shows the checkmark indicator (✓) when true.
   * @default false
   */
  isSelected?: boolean

  /**
   * The content to display for this item.
   */
  children: ReactNode

  /**
   * Optional description text displayed below the main content.
   */
  description?: string

  /**
   * Show a down arrow indicator instead of pointer (for scroll hints).
   * Only applies when not focused.
   */
  showScrollDown?: boolean

  /**
   * Show an up arrow indicator instead of pointer (for scroll hints).
   * Only applies when not focused.
   */
  showScrollUp?: boolean

  /**
   * Whether to apply automatic styling to the children based on focus/selection state.
   * - When true (default): children are wrapped in Text with state-based colors
   * - When false: children are rendered as-is, allowing custom styling
   * @default true
   */
  styled?: boolean

  /**
   * Whether this item is disabled. Disabled items show dimmed text and no indicators.
   * @default false
   */
  disabled?: boolean

  /**
   * Whether this ListItem should declare the terminal cursor position.
   * Set false when a child (e.g. BaseTextInput) declares its own cursor.
   * @default true
   */
  declareCursor?: boolean

  /**
   * Official 2.1.187 — mouse click handler (fullscreen / SGR mouse).
   * When set, hovering shows a dim pointer and clicks select the item.
   */
  onClick?: (event: ClickEvent) => void

  /**
   * Optional hover change callback (true on enter, false on leave).
   */
  onHoverChange?: (hovered: boolean) => void
}

/**
 * A list item component for selection UIs (dropdowns, multi-selects, menus).
 *
 * Handles the common pattern of:
 * - Pointer indicator (❯) for focused items
 * - Checkmark indicator (✓) for selected items
 * - Scroll indicators (↓↑) for truncated lists
 * - Color states for focus/selection
 * - Mouse click / hover (official 2.1.187) when onClick is provided
 */
export function ListItem({
  isFocused,
  isSelected = false,
  children,
  description,
  showScrollDown,
  showScrollUp,
  styled = true,
  disabled = false,
  declareCursor,
  onClick,
  onHoverChange,
}: ListItemProps): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  const clickable = !disabled && onClick !== undefined
  const hoverable = !disabled && (onClick !== undefined || onHoverChange !== undefined)

  function handleHoverChange(next: boolean): void {
    setHovered(next)
    onHoverChange?.(next)
  }

  // Determine which indicator to show (official 2.1.187 `uvd`)
  function renderIndicator(): ReactNode {
    if (disabled) {
      return <Text> </Text>
    }

    if (isFocused) {
      return <Text color="suggestion">{figures.pointer}</Text>
    }

    if (showScrollDown) {
      return <Text dimColor>{figures.arrowDown}</Text>
    }

    if (showScrollUp) {
      return <Text dimColor>{figures.arrowUp}</Text>
    }

    if (hovered && clickable) {
      return <Text dimColor>{figures.pointer}</Text>
    }

    return <Text> </Text>
  }

  // Determine text color based on state
  function getTextColor(): 'success' | 'suggestion' | 'inactive' | undefined {
    if (disabled) {
      return 'inactive'
    }

    if (!styled) {
      return undefined
    }

    if (isSelected) {
      return 'success'
    }

    if (isFocused) {
      return 'suggestion'
    }

    return undefined
  }

  const textColor = getTextColor()

  // Park the native terminal cursor on the pointer indicator so screen
  // readers / magnifiers track the focused item. (0,0) is the top-left of
  // this Box, where the pointer renders.
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && !disabled && declareCursor !== false,
  })

  return (
    <Box
      ref={cursorRef}
      flexDirection="column"
      onClick={clickable ? onClick : undefined}
      onMouseEnter={hoverable ? () => handleHoverChange(true) : undefined}
      onMouseLeave={hoverable ? () => handleHoverChange(false) : undefined}
    >
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>{renderIndicator()}</Box>
        {styled ? (
          <Text color={textColor} dimColor={disabled}>
            {children}
          </Text>
        ) : (
          children
        )}
        {isSelected && !disabled && <Text color="success">{figures.tick}</Text>}
      </Box>
      {description && (
        <Box paddingLeft={2}>
          <Text color="inactive">{description}</Text>
        </Box>
      )}
    </Box>
  )
}
