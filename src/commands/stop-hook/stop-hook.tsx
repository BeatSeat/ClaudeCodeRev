import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { PromptHook } from '../../schemas/hooks.js'
import {
  addSessionHook,
  removeSessionHook,
} from '../../utils/hooks/sessionHooks.js'

function getSessionStopPromptHooks(
  appState: AppState,
  sessionId: string,
): PromptHook[] {
  const store = appState.sessionHooks.get(sessionId)
  const matchers = store?.hooks.Stop ?? []
  const hooks: PromptHook[] = []
  for (const matcher of matchers) {
    for (const entry of matcher.hooks) {
      if (entry.hook.type === 'prompt') {
        hooks.push(entry.hook)
      }
    }
  }
  return hooks
}

function StopHookDialog({
  initialPrompt,
  existingHookPresent,
  onSubmit,
  onCancel,
}: {
  initialPrompt: string
  existingHookPresent: boolean
  onSubmit: (prompt: string) => void
  onCancel: () => void
}): React.ReactNode {
  const [value, setValue] = React.useState(initialPrompt)
  const [cursorOffset, setCursorOffset] = React.useState(initialPrompt.length)
  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold>
        {existingHookPresent
          ? 'Edit session Stop hook (empty + Enter clears)'
          : 'Set a session-only Stop hook'}
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onExit={onCancel}
        placeholder="Prompt to run when Claude stops…"
        columns={80}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        focus
        showCursor
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const sessionId = getSessionId()
  const existing = getSessionStopPromptHooks(context.getAppState(), sessionId)
  const existingPrompt = existing[0]?.prompt
  const initialPrompt = args.trim() || existingPrompt || ''

  function submit(next: string) {
    if (next.length === 0) {
      for (const hook of existing) {
        removeSessionHook(context.setAppState, sessionId, 'Stop', hook)
      }
      const message = existing.length > 0 ? 'Stop hook cleared' : 'Cancelled'
      if (existing.length > 0) {
        logEvent('tengu_stop_hook_removed', {})
      }
      onDone(message, { display: 'system' })
      return
    }
    if (existingPrompt === next) {
      onDone('Stop hook unchanged', { display: 'system' })
      return
    }
    for (const hook of existing) {
      removeSessionHook(context.setAppState, sessionId, 'Stop', hook)
    }
    addSessionHook(context.setAppState, sessionId, 'Stop', '', {
      type: 'prompt',
      prompt: next,
    })
    logEvent('tengu_stop_hook_added', { promptLength: next.length })
    onDone(existing.length === 0 ? 'Stop hook set' : 'Stop hook updated', {
      display: 'system',
    })
  }

  return (
    <StopHookDialog
      initialPrompt={initialPrompt}
      existingHookPresent={existingPrompt !== undefined}
      onSubmit={submit}
      onCancel={() => onDone('Cancelled', { display: 'system' })}
    />
  )
}
