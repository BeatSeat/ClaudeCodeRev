import React from 'react'
import type { Styles } from '../../ink/styles.js'
import { Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

type ThemeColor = keyof Theme

type Props = {
  children: React.ReactNode
  /** Background theme key (118 `dO` `color`). */
  color?: ThemeColor
  /** Foreground theme key. Defaults to `inverseText` when `color` is set. */
  textColor?: ThemeColor
  /** Pad children with a space on each side. */
  padded?: boolean
  bold?: boolean
  wrap?: Styles['textWrap']
}

/** Official 2.1.118 `dO` — themed badge with explicit text color. */
export function Badge({
  children,
  color,
  textColor,
  padded,
  bold,
  wrap,
}: Props): React.ReactNode {
  const pad = padded ? ' ' : ''
  const fg = textColor ?? (color ? 'inverseText' : undefined)
  return (
    <Text backgroundColor={color} color={fg} bold={bold} wrap={wrap}>
      {pad}
      {children}
      {pad}
    </Text>
  )
}
