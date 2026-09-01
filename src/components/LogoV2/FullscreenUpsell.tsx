import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

const FULLSCREEN_UPSELL_MAX = 3

function shouldShowFullscreenUpsell(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL)) return true
  if (isFullscreenEnvEnabled()) return false
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_ochre_hollow', false)) {
    return false
  }
  if ((getGlobalConfig().fullscreenUpsellSeenCount ?? 0) >= FULLSCREEN_UPSELL_MAX) {
    return false
  }
  return true
}

export function useShowFullscreenUpsell(): boolean {
  const justSwitched = process.env.CLAUDE_CODE_TUI_JUST_SWITCHED !== undefined
  const [show] = useState(() => shouldShowFullscreenUpsell() && !justSwitched)
  return show
}

export function incrementFullscreenUpsellSeenCount(): void {
  let seenCount = 0
  saveGlobalConfig(prev => {
    seenCount = (prev.fullscreenUpsellSeenCount ?? 0) + 1
    return { ...prev, fullscreenUpsellSeenCount: seenCount }
  })
  logEvent('tengu_fullscreen_upsell_shown', { seen_count: seenCount })
}

/** Official WQK — flicker-free renderer hint on the condensed logo. */
export function FullscreenUpsell(): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>
          <Text color="autoAccept"> Try the new fullscreen renderer</Text>
          <Text dimColor> · /tui fullscreen</Text>
        </Text>
      </Box>
      <Text dimColor>  · Flicker-free output</Text>
      <Text dimColor>  · Lower memory usage in long conversations</Text>
      <Text dimColor>
        {'  '}· Mouse support — click to move your cursor or expand results
      </Text>
      <Text dimColor>  · Selected text auto-copies to your clipboard</Text>
    </Box>
  )
}

/** Official DQK — post-/tui relaunch banner. */
export function TuiJustSwitchedNotice(): React.ReactNode {
  switch (process.env.CLAUDE_CODE_TUI_JUST_SWITCHED) {
    case 'fullscreen':
      return (
        <Box flexDirection="column">
          <Text>
            <Text color="success">Using flicker-free rendering</Text>
            <Text dimColor> · go back with /tui default</Text>
          </Text>
          <Text dimColor>  · Click to move your cursor in the text input</Text>
          <Text dimColor>  · Click to expand collapsed tool results</Text>
          <Text dimColor>
            {'  '}· By default, text auto-copies when you select it (/config to
            change)
          </Text>
        </Box>
      )
    case 'default':
      return <Text dimColor>Switched back to the classic renderer</Text>
    default:
      return null
  }
}
