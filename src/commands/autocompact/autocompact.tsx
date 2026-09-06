import * as React from 'react'
import { useState } from 'react'
import { getSdkBetas } from '../../bootstrap/state.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
  AUTO_COMPACT_WINDOW_STEP,
  formatAutoCompactWindowStatus,
  resolveAutoCompactWindow,
  setAutoCompactWindowFromArg,
  sourceLabel,
} from '../../utils/autoCompactWindow.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { formatTokens } from '../../utils/format.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

const LONG_CONTEXT_URL = 'https://claude.com/blog/1m-context-ga'

function currentResolved(model: string) {
  const modelWindow = getContextWindowForModel(model, getSdkBetas())
  const settingsWindow = isAutoCompactEnabled()
    ? (getInitialSettings().autoCompactWindow ?? undefined)
    : undefined
  return {
    modelWindow,
    ...resolveAutoCompactWindow(modelWindow, settingsWindow, model),
  }
}

function AutoCompactDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const model = useMainLoopModel()
  const setAppState = useSetAppState()
  const resolved = currentResolved(model)
  const envLocked = resolved.source === 'env'
  const initial =
    resolved.source === 'auto' || resolved.source === 'clientdata'
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
      : resolved.source === 'clientdata'
        ? `auto (${formatTokens(resolved.configured)} tokens)${
            resolved.configured > resolved.window
              ? ` · capped to ${formatTokens(resolved.window)} by model`
              : ''
          }`
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
    const message = setAutoCompactWindowFromArg(arg, resolved.modelWindow, model)
    setAppState(prev => ({
      ...prev,
      autoCompactWindow: getInitialSettings().autoCompactWindow,
    }))
    onDone(message)
  }

  useKeybindings(
    {
      'select:previous': () => step(-1),
      'select:next': () => step(1),
      'select:accept': accept,
      'tabs:next': () => step(1),
      'tabs:previous': () => step(-1),
    },
    { context: 'Select' },
  )

  return (
    <Dialog
      title="Auto-compact Window"
      subtitle={`Current setting: ${currentLabel}`}
      onCancel={() => onDone(`Auto-compact window unchanged: ${currentLabel}`)}
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
          <Text>
            Select auto-compact window:{' '}
            <Text bold color="suggestion">
              {selectedLabel}
            </Text>
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Long context that holds up</Text>
          <Text>
            Both Opus 4.6 and Sonnet 4.6 achieve state-of-the-art scores on
            long-context retrieval benchmarks at 1M tokens — Opus 4.6 scores
            78.3% on MRCR v2, the highest among frontier models at that length.
            Opus 4.6 includes 1M context at standard pricing; Sonnet 4.6 1M is
            available with overages.
          </Text>
          <Text dimColor>Learn more: {LONG_CONTEXT_URL}</Text>
        </Box>
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim() || ''
  if (trimmed) {
    const { getMainLoopModel } = await import('../../utils/model/model.js')
    const model = getMainLoopModel()
    const modelWindow = getContextWindowForModel(model, getSdkBetas())
    onDone(setAutoCompactWindowFromArg(trimmed, modelWindow, model))
    return null
  }
  return <AutoCompactDialog onDone={onDone} />
}
