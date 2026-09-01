import chalk from 'chalk'
import * as React from 'react'
import { LIGHTNING_BOLT } from '../constants/figures.js'
import { Text } from '../ink.js'
import { getUserIntentSetting } from '../utils/settings/userIntent.js'
import { resolveThemeSetting } from '../utils/systemTheme.js'
import { color } from './design-system/color.js'

type Props = {
  cooldown?: boolean
}

export function FastIcon({ cooldown }: Props): React.ReactNode {
  if (cooldown) {
    return (
      <Text color="promptBorder" dimColor>
        {LIGHTNING_BOLT}
      </Text>
    )
  }
  return <Text color="fastMode">{LIGHTNING_BOLT}</Text>
}

export function getFastIconString(applyColor = true, cooldown = false): string {
  if (!applyColor) {
    return LIGHTNING_BOLT
  }
  const themeName = resolveThemeSetting(
    getUserIntentSetting('theme', 'dark') ?? 'dark',
  )
  if (cooldown) {
    return chalk.dim(color('promptBorder', themeName)(LIGHTNING_BOLT))
  }
  return color('fastMode', themeName)(LIGHTNING_BOLT)
}
