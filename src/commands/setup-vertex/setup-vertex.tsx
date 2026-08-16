import * as React from 'react'
import { VertexSetupWizard } from '../../components/vertex-setup/VertexSetupWizard.js'
import { Box, Text, useApp } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { execRelaunch } from '../../utils/relaunch.js'

function SetupVertex({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const { exit } = useApp()
  const [message, setMessage] = React.useState<string | null>(null)

  useKeybinding(
    'confirm:yes',
    () => {
      exit()
      void Promise.resolve().then(() => execRelaunch())
    },
    { context: 'Confirmation', isActive: message !== null },
  )

  if (message !== null) {
    return (
      <Box flexDirection="column" gap={1} marginTop={1}>
        <Text color="success">{message}</Text>
        <Text dimColor>
          Press <Text bold>Enter</Text> to restart Claude Code.
        </Text>
      </Box>
    )
  }

  return (
    <VertexSetupWizard
      onComplete={next => setMessage(next)}
      onCancel={() => {
        logEvent('tengu_vertex_setup_cancelled', {})
        onDone()
      }}
    />
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  logEvent('tengu_vertex_setup_started', {})
  return <SetupVertex onDone={onDone} />
}
