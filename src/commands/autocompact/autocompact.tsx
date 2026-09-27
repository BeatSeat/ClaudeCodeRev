import * as React from 'react'
import { useState } from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import { useAppState } from '../../state/AppState.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
  AUTO_COMPACT_WINDOW_STEP,
  resolveAutoCompactWindow,
  setAutoCompactWindowFromArg,
  sourceLabel,
} from '../../utils/autoCompactWindow.js'
import { formatTokens } from '../../utils/format.js'

function AutoCompactDialog({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}): React.ReactNode {
  const model = useMainLoopModel()
  const stateWindow = useAppState(state => state.autoCompactWindow)
  const resolved = resolveAutoCompactWindow(model, stateWindow)
  const envLocked = resolved.source === 'env'
  const initial =
    resolved.source === 'auto'
      ? 0
      : Math.min(
          AUTO_COMPACT_WINDOW_MAX,
          Math.max(
            AUTO_COMPACT_WINDOW_MIN,
            Math.round(resolved.configured / AUTO_COMPACT_WINDOW_STEP) *
              AUTO_COMPACT_WINDOW_STEP,
          ),
        )
  const [selected, setSelected] = useState(initial)
  const [dirty, setDirty] = useState(false)

  const currentLabel =
    resolved.source === 'auto'
      ? 'auto'
      : `${formatTokens(resolved.configured)} tokens (${sourceLabel(resolved.source)})${
          resolved.configured > resolved.window
            ? ` · capped to ${formatTokens(resolved.window)} by model`
            : ''
        }`
  const selectedLabel =
    selected === 0 ? 'auto' : `${formatTokens(selected)} tokens`

  function step(delta: number): void {
    if (envLocked) return
    setDirty(true)
    setSelected(prev => {
      if (prev === 0) {
        return delta > 0 ? AUTO_COMPACT_WINDOW_MIN : AUTO_COMPACT_WINDOW_MAX
      }
      const next = prev + delta * AUTO_COMPACT_WINDOW_STEP
      if (next < AUTO_COMPACT_WINDOW_MIN) return 0
      if (next > AUTO_COMPACT_WINDOW_MAX) return 0
      return next
    })
  }

  function accept(): void {
    if (!dirty) {
      onDone(`Auto-compact window unchanged: ${currentLabel}`)
      return
    }
    const arg = selected === 0 ? 'auto' : String(selected)
    const message = setAutoCompactWindowFromArg(arg, context)
    onDone(message)
  }

  useKeybindings(
    {
      'select:previous': () => step(1),
      'select:next': () => step(-1),
      'select:accept': accept,
    },
    { context: 'Select' },
  )
  useKeybindings(
    {
      'tabs:next': () => step(1),
      'tabs:previous': () => step(-1),
    },
    { context: 'Tabs' },
  )

  return (
    <Dialog
      title="Auto-compact Window"
      subtitle={`Current setting: ${currentLabel}`}
      onCancel={() => onDone(`Auto-compact window unchanged: ${currentLabel}`)}
      inputGuide={() => (
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint chord={['up', 'down']} action="change" />
            <KeyboardShortcutHint chord="enter" action="apply" />
            <KeyboardShortcutHint chord="escape" action="cancel" />
          </Byline>
        </Text>
      )}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          This command configures when auto-compaction happens. The actual
          threshold is the minimum of this setting and your model&apos;s maximum
          context window.
        </Text>
        <Text>
          The auto setting picks a window tuned for your model and is{' '}
          <Text bold>strongly recommended</Text> for the best cost and
          performance. You can override it below.
        </Text>
        {!isAutoCompactEnabled() && (
          <Text color="warning">
            Auto-compact is currently disabled (see /config)
          </Text>
        )}
        {selected !== 0 && (
          <Text color="warning">
            Overriding auto may result in high token usage, especially when
            resuming long sessions.
          </Text>
        )}
        {envLocked ? (
          <Text color="warning">
            CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset
            it to change this setting here.
          </Text>
        ) : (
          <Box>
            <Text>Select auto-compact window: </Text>
            <Text bold color="suggestion">{selectedLabel}</Text>
          </Box>
        )}

      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim() || ''
  if (trimmed) {
    onDone(setAutoCompactWindowFromArg(trimmed, context))
    return null
  }
  logEvent('tengu_autocompact_dialog_opened', {
    source: 'dialog' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return <AutoCompactDialog onDone={onDone} context={context} />
}
