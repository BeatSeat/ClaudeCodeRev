import { homedir } from 'os'
import { sep } from 'path'
import * as React from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { logError } from '../../utils/log.js'
import {
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { withTimeout } from '../../utils/sleep.js'
import { plural } from '../../utils/stringUtils.js'
import {
  type EditorSensitivity,
  editorSensitivityLabel,
  readEditorWheelSensitivity,
} from './editorSensitivity.js'
import {
  SCROLL_SPEED_ENV,
  autoScrollSpeed,
  clampSlider,
  getScrollProfile,
  invalidateScrollProfile,
  speedBar,
  terminalSummary,
} from './scrollProfile.js'

const DEMO_RULER_MESSAGE_LIMIT = 20

type Props = {
  onDone: (result?: string) => void
  showDemoRuler?: boolean
  editorSensitivity?: EditorSensitivity | null
}

/** Official 139 a_H — home-dir tilde, not cwd-relative. */
function tildeHome(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(home + sep)) return '~' + path.slice(home.length)
  return path
}

/**
 * Official 139 X76 / tmH / UEK — demo-ruler + wheel-sample pub/sub.
 * The fullscreen wheel handler (J76) is not in this hop's allowed files;
 * subscribers stay idle and telemetry saw_* flags stay false.
 */
let demoEnabled = false
let demoRulerOn = false
let lastDemoWheel: { wheelMode: boolean } | null = null
const demoListeners = new Set<() => void>()

function setScrollDemoMode(
  enabled: boolean,
  opts?: { demoRuler?: boolean },
): void {
  const demoRuler = enabled && (opts?.demoRuler ?? true)
  if (demoEnabled === enabled && demoRulerOn === demoRuler) return
  demoEnabled = enabled
  demoRulerOn = demoRuler
  if (!enabled) lastDemoWheel = null
  for (const listener of demoListeners) listener()
}

function subscribeScrollDemo(fn: () => void): () => void {
  demoListeners.add(fn)
  return () => {
    demoListeners.delete(fn)
  }
}

function getScrollDemoWheel(): { wheelMode: boolean } | null {
  return lastDemoWheel
}

function InfoRow({
  label,
  value,
}: {
  label: string
  value: string
}): React.ReactNode {
  return (
    <Box>
      <Box width={12}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )
}

/** Official 139 Q34 */
function ScrollSpeedDialog({
  onDone,
  showDemoRuler = true,
  editorSensitivity = null,
}: Props): React.ReactNode {
  const envSnapshot = React.useRef(process.env[SCROLL_SPEED_ENV])
  const profile = getScrollProfile()
  const auto = autoScrollSpeed(
    profile.xtermJs,
    profile.wheelFlood,
    profile.wtSession,
  )
  const [speed, setSpeed] = React.useState(() =>
    clampSlider(Math.round(profile.base)),
  )
  const [customized, setCustomized] = React.useState(
    envSnapshot.current !== undefined,
  )
  const sawWheel = React.useRef(false)
  const sawTrackpad = React.useRef(false)
  const useNativeWheelSample =
    !profile.xtermJs && !profile.wheelFlood

  React.useEffect(() => {
    setScrollDemoMode(true, { demoRuler: showDemoRuler })
    const unsub = useNativeWheelSample
      ? subscribeScrollDemo(() => {
          const sample = getScrollDemoWheel()
          if (!sample) return
          if (sample.wheelMode) sawWheel.current = true
          else sawTrackpad.current = true
        })
      : undefined
    return () => {
      unsub?.()
      setScrollDemoMode(false)
    }
  }, [showDemoRuler, useNativeWheelSample])

  function applyLive(next: number): void {
    const clamped = clampSlider(speed + next)
    if (clamped === speed) return
    process.env[SCROLL_SPEED_ENV] = String(clamped)
    invalidateScrollProfile()
    setCustomized(true)
    setSpeed(clamped)
  }

  function resetToAuto(): void {
    delete process.env[SCROLL_SPEED_ENV]
    invalidateScrollProfile()
    setSpeed(clampSlider(Math.round(auto)))
    setCustomized(false)
  }

  function restoreEnv(): void {
    if (envSnapshot.current === undefined) delete process.env[SCROLL_SPEED_ENV]
    else process.env[SCROLL_SPEED_ENV] = envSnapshot.current
    invalidateScrollProfile()
  }

  function cancel(): void {
    restoreEnv()
    onDone('Scroll speed unchanged')
  }

  function save(): void {
    const resetToAutoSave = !customized
    const env = {
      [SCROLL_SPEED_ENV]: resetToAutoSave ? undefined : String(speed),
    }
    const { error } = updateSettingsForSource('userSettings', { env })
    if (error) {
      logError(error)
      restoreEnv()
      onDone(`Couldn't save scroll speed: ${error.message}`)
      return
    }
    logEvent('tengu_scroll_speed_set', {
      scroll_speed: resetToAutoSave ? auto : speed,
      scroll_speed_auto: auto,
      reset_to_auto: resetToAutoSave,
      xterm_js: profile.xtermJs,
      wheel_flood: profile.wheelFlood,
      wt_session: profile.wtSession,
      use_decay_curve: profile.useDecayCurve,
      saw_scroll_wheel: sawWheel.current,
      saw_trackpad: sawTrackpad.current,
      editor_wheel_sensitivity: editorSensitivity?.sensitivity ?? undefined,
      term_program:
        profile.termProgram as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      term_program_version:
        profile.termProgramVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const settingsPath = `\`${tildeHome(getSettingsFilePathForSource('userSettings') ?? 'settings.json')}\``
    onDone(
      resetToAutoSave
        ? `Scroll speed reset to auto (${auto} ${plural(auto, 'line')} per notch) · removed from ${settingsPath}`
        : `Scroll speed set to ${speed} ${plural(speed, 'line')} per notch · saved to ${settingsPath}`,
    )
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'left') {
      event.preventDefault()
      applyLive(-1)
    } else if (event.key === 'right') {
      event.preventDefault()
      applyLive(1)
    } else if (event.key === 'return') {
      event.preventDefault()
      save()
    } else if (
      event.key === 'escape' ||
      (event.ctrl && (event.key === 'c' || event.key === 'd'))
    ) {
      event.preventDefault()
      cancel()
    } else if (event.key === 'r') {
      event.preventDefault()
      resetToAuto()
    }
  }

  const isAuto = !customized
  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={onKeyDown}
    >
      <Pane color="permission">
        <Box flexDirection="column">
          <Text bold>Scroll speed</Text>
          <Box height={1} />
          <Box>
            <Text color="permission">{speedBar(speed)}</Text>
            <Text>
              {'  '}
              {speed} {plural(speed, 'line')} per wheel notch
            </Text>
            {isAuto && <Text dimColor> (auto)</Text>}
            {!isAuto && <Text dimColor> · auto is {auto}</Text>}
          </Box>
          <Box height={1} />
          <InfoRow label="Terminal" value={terminalSummary(profile)} />
          {editorSensitivity && (
            <InfoRow
              label="Editor"
              value={editorSensitivityLabel(editorSensitivity)}
            />
          )}
          <Box height={1} />
          <Text dimColor>
            Scroll to feel it · ←/→ adjust · r reset to auto · Enter save · Esc cancel
          </Text>
        </Box>
      </Pane>
    </Box>
  )
}

/** Official 139 IL5 / c34.call */
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const showDemoRuler = context.messages.length < DEMO_RULER_MESSAGE_LIMIT
  const editorSensitivity = await withTimeout(
    readEditorWheelSensitivity(),
    250,
    'VS Code settings read timed out',
  ).catch(() => null)
  return (
    <ScrollSpeedDialog
      onDone={onDone}
      showDemoRuler={showDemoRuler}
      editorSensitivity={editorSensitivity}
    />
  )
}
