import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { Box, Text } from '../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { Dialog } from './design-system/Dialog.js'

// Official 2.1.152 `Ayz` — copy extracted verbatim from cometix 2.1.152 cli.js
export const AUTO_DEFAULT_NOTICE_TITLE =
  "Auto mode is now Claude Code's default permission mode"

export const AUTO_DEFAULT_NOTICE_BODY =
  'Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest.'

type Props = {
  onDone(): void
}

function markSeenAutoDefaultNotice(): void {
  saveGlobalConfig(current =>
    current.hasSeenAutoDefaultNotice
      ? current
      : { ...current, hasSeenAutoDefaultNotice: true },
  )
}

export function AutoDefaultNoticeDialog({ onDone }: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_auto_default_notice_shown', {})
  }, [])

  function confirm(): void {
    markSeenAutoDefaultNotice()
    onDone()
  }

  useKeybinding('confirm:yes', confirm, { context: 'Confirmation' })

  return (
    <Dialog title={AUTO_DEFAULT_NOTICE_TITLE} onCancel={confirm}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text>{AUTO_DEFAULT_NOTICE_BODY}</Text>
        </Box>
        <Text dimColor>Enter to continue</Text>
      </Box>
    </Dialog>
  )
}

export function shouldShowAutoDefaultNotice(mode: string): boolean {
  const config = getGlobalConfig()
  return (
    mode === 'auto' &&
    config.hasCompletedOnboarding === true &&
    !config.hasSeenAutoDefaultNotice
  )
}
