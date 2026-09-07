import React, { type ReactNode } from 'react'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { ListItem } from '../design-system/ListItem.js'

export type SelectOptionProps = {
  /**
   * Determines if option is focused.
   */
  readonly isFocused: boolean

  /**
   * Determines if option is selected.
   */
  readonly isSelected: boolean

  /**
   * Option label.
   */
  readonly children: ReactNode

  /**
   * Optional description to display below the label.
   */
  readonly description?: string

  /**
   * Determines if the down arrow should be shown.
   */
  readonly shouldShowDownArrow?: boolean

  /**
   * Determines if the up arrow should be shown.
   */
  readonly shouldShowUpArrow?: boolean

  /**
   * Whether ListItem should declare the terminal cursor position.
   * Set false when a child declares its own cursor (e.g. BaseTextInput).
   */
  readonly declareCursor?: boolean

  /**
   * Official 2.1.187 — mouse click selects this option in fullscreen.
   */
  readonly onClick?: (event: ClickEvent) => void
}

export function SelectOption({
  isFocused,
  isSelected,
  children,
  description,
  shouldShowDownArrow,
  shouldShowUpArrow,
  declareCursor,
  onClick,
}: SelectOptionProps): React.ReactNode {
  return (
    <ListItem
      isFocused={isFocused}
      isSelected={isSelected}
      description={description}
      showScrollDown={shouldShowDownArrow}
      showScrollUp={shouldShowUpArrow}
      styled={false}
      declareCursor={declareCursor}
      onClick={onClick}
    >
      {children}
    </ListItem>
  )
}
