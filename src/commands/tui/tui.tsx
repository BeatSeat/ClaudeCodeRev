import * as React from 'react'
import { useRef, useState } from 'react'
import { getIsInteractive, getSessionId } from '../../bootstrap/state.js'
import { redactSensitiveInfo } from '../../components/Feedback.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
  logEventAsync,
} from '../../services/analytics/index.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { isBgSession } from '../../utils/concurrentSessions.js'
import {
  getTuiEntryPath,
  isFullscreenEnvEnabled,
  isTuiDownsellGate,
} from '../../utils/fullscreen.js'
import { logError } from '../../utils/log.js'
import { getAxScreenReaderSpawnEnv } from '../../utils/axScreenReaderEnv.js'
import { execRelaunchSession } from '../../utils/relaunch.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const RENDERERS = ['default', 'fullscreen'] as const
type Renderer = (typeof RENDERERS)[number]

function currentRenderer(): Renderer {
  return (
    getInitialSettings().tui ??
    (isFullscreenEnvEnabled() ? 'fullscreen' : 'default')
  )
}

async function relaunchRenderer(
  renderer: Renderer,
  onDone: LocalJSXCommandOnDone,
): Promise<void> {
  try {
    await execRelaunchSession({
      freshIfNoTranscript: true,
      // Official 2.1.179 `...ULH()` on tui respawn env
      env: {
        CLAUDE_CODE_TUI_JUST_SWITCHED: renderer,
        ...getAxScreenReaderSpawnEnv(),
      },
      dropEnv: [
        'CLAUDE_CODE_NO_FLICKER',
        'CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL',
      ],
      sessionId: getSessionId(),
    })
  } catch (error) {
    logError(error)
    onDone(
      `Couldn't switch renderers \u2014 ${error instanceof Error ? error.message : String(error)}. The setting was saved; restart Claude Code to apply it.`,
      { display: 'system' },
    )
  }
}

/**
 * Official 2.1.143 `gk5`: optional reason when leaving fullscreen.
 * Esc/`confirm:no` submits empty (skip) then still relaunches.
 */
function TuiOptOutForm(props: {
  fromEntryPath: string
  bounce: boolean
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const { fromEntryPath, bounce, onDone } = props
  const [value, setValue] = useState('')
  const submitted = useRef(false)
  const { columns } = useTerminalSize()

  const submit = async (raw: string): Promise<void> => {
    if (submitted.current) return
    submitted.current = true
    const trimmed = raw.trim()
    if (trimmed) {
      await logEventAsync('tengu_tui_optout_reason', {
        reason: redactSensitiveInfo(
          trimmed,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        from_entry_path:
          fromEntryPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        bounce,
        downsell_gate: isTuiDownsellGate() === true,
      }).catch(logError)
    }
    await relaunchRenderer('default', onDone)
  }

  useKeybinding('confirm:no', () => void submit(''), { context: 'Settings' })

  const width = Math.max(10, columns - 4)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        To help us make fullscreen mode better, what made you switch back?
        (optional, Enter to skip)
      </Text>
      <Box flexDirection="row" gap={1}>
        <Text>{'>'}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          placeholder={'e.g., "couldn\u2019t copy text"'}
          focus
          showCursor
          columns={width}
        />
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const requested = args.trim().toLowerCase()
  if (requested === '') {
    onDone(
      `Current renderer: ${currentRenderer()}. Usage: /tui <${RENDERERS.join('|')}>`,
      { display: 'system' },
    )
    return null
  }
  if (!(RENDERERS as readonly string[]).includes(requested)) {
    onDone(
      `Unknown renderer "${requested}". Usage: /tui <${RENDERERS.join('|')}>`,
      { display: 'system' },
    )
    return null
  }
  if (isBgSession()) {
    onDone(
      "Renderer switching isn\u2019t available in a background session \u2014 press \u2190 to detach and run /tui from a foreground session.",
      { display: 'system' },
    )
    return null
  }

  const renderer = requested as Renderer
  const fullscreen = renderer === 'fullscreen'
  const fromRenderer = currentRenderer()
  const already = fullscreen === isFullscreenEnvEnabled()
  if (already && getInitialSettings().tui !== undefined) {
    onDone(`Already using the ${renderer} renderer.`, { display: 'system' })
    return null
  }

  const { error } = updateSettingsForSource('userSettings', { tui: renderer })
  if (error) {
    onDone(`Failed to save setting: ${error.message}`, { display: 'system' })
    return null
  }

  const fromEntryPath = getTuiEntryPath()
  const bounce =
    (process.env.CLAUDE_CODE_TUI_JUST_SWITCHED === 'fullscreen' ||
      fromEntryPath === 'downsell_on' ||
      isTuiDownsellGate()) &&
    renderer === 'default'

  logEvent('tengu_tui_command', {
    fullscreen,
    from: fromRenderer as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    to: renderer as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    from_entry_path:
      fromEntryPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    bounce,
  })

  if (already) {
    onDone(`Already using the ${renderer} renderer.`, { display: 'system' })
    return null
  }

  if (
    renderer === 'default' &&
    (bounce || fromEntryPath === 'gb_on') &&
    getIsInteractive() &&
    isPolicyAllowed('allow_product_feedback')
  ) {
    return (
      <TuiOptOutForm
        fromEntryPath={fromEntryPath}
        bounce={bounce}
        onDone={onDone}
      />
    )
  }

  await relaunchRenderer(renderer, onDone)
  return null
}
