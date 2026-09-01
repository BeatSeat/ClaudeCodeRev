import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'

/** Official 2.1.154 `DKz`. */
const OPUS48_LAUNCH_MAX_SEEN = 8

/** Official 2.1.154 `JKz`. */
const OPUS_48_HERE = 'Opus 4.8 is here!'
/** Official 2.1.154 `XKz`. */
const OPUS_48_EFFORT =
  ' Now defaults to high effort · /effort xhigh for your hardest tasks'
/** Official 2.1.154 `LKz`. */
const OPUS_48_AVAILABLE = 'Opus 4.8 is now available!'
/** Official 2.1.154 `PKz`. */
const OPUS_48_MODEL_SWITCH = ' · /model to switch'

/**
 * Official 2.1.154 `De6` / `WKz`.
 * firstParty only; hide after `opus48LaunchSeenCount` reaches 8.
 */
export function shouldShowOpus48Notice(): boolean {
  if (getAPIProvider() !== 'firstParty') return false
  if ((getGlobalConfig().opus48LaunchSeenCount ?? 0) >= OPUS48_LAUNCH_MAX_SEEN) {
    return false
  }
  return true
}

/** Official 2.1.154 `ZKz`. */
function incrementOpus48LaunchSeen(): void {
  saveGlobalConfig(prev => ({
    ...prev,
    opus48LaunchSeenCount: (prev.opus48LaunchSeenCount ?? 0) + 1,
  }))
  logEvent('tengu_opus48_launch_shown', {})
}

/** Official 2.1.154 `GKz`. */
function Opus48NoticeCopy({
  isOnOpus48,
}: {
  isOnOpus48: boolean
}): React.ReactNode {
  const title = isOnOpus48 ? OPUS_48_HERE : OPUS_48_AVAILABLE
  const subtitle = isOnOpus48 ? OPUS_48_EFFORT : OPUS_48_MODEL_SWITCH
  return (
    <Text dimColor>
      <Text color="claude" bold>
        {title}
      </Text>
      {subtitle}
    </Text>
  )
}

/** Official 2.1.154 `JB4` — increment on mount (`TKz` → `ZKz`). */
export function Opus48Notice(): React.ReactNode {
  const [show] = useState(shouldShowOpus48Notice)
  const model = useMainLoopModel()
  const isOnOpus48 = getCanonicalName(model) === 'claude-opus-4-8'

  useEffect(() => {
    if (!show) return
    incrementOpus48LaunchSeen()
  }, [show])

  if (!show) return null

  return (
    <Box paddingLeft={2}>
      <Opus48NoticeCopy isOnOpus48={isOnOpus48} />
    </Box>
  )
}
