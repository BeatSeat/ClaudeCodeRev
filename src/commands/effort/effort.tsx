import * as React from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text, useAnimationFrame, useInput } from '../../ink.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLevel,
  getEffortEnvOverride,
  getEffortValueDescription,
  isEffortLevel,
  toPersistableEffort,
  unpinOpus47LaunchEffort,
} from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { getRainbowColor } from '../../utils/thinking.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']

type SliderColor =
  | 'warning'
  | 'success'
  | 'permission'
  | 'autoAccept-shimmer'
  | 'rainbow-animated'

const SLIDER_LEVELS: { value: EffortLevel; color: SliderColor }[] = [
  { value: 'low', color: 'warning' },
  { value: 'medium', color: 'success' },
  { value: 'high', color: 'permission' },
  { value: 'xhigh', color: 'autoAccept-shimmer' },
  { value: 'max', color: 'rainbow-animated' },
]
const DEFAULT_SLIDER_INDEX = 3
const TRACK_WIDTH = 42
const POINTER_AT = [1, 10, 20, 30, 40]
const LABEL_GAPS = [5, 5, 5, 6]
const XHIGH_SHIMMER = '#d0b4ff'

type EffortCommandResult = {
  message: string
  effortUpdate?: { value: EffortValue | undefined }
}

function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  unpinOpus47LaunchEffort()
  const persistable = toPersistableEffort(effortValue)
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable,
    })
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`,
      }
    }
  }
  logEvent('tengu_effort_command', {
    effort:
      effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: { value: effortValue },
      }
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: { value: effortValue },
    }
  }

  const description = getEffortValueDescription(effortValue)
  const suffix = persistable !== undefined ? '' : ' (this session only)'
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: { value: effortValue },
  }
}

export function showCurrentEffort(
  appStateEffort: EffortValue | undefined,
  model: string,
): EffortCommandResult {
  const envOverride = getEffortEnvOverride()
  const effectiveValue =
    envOverride === null ? undefined : (envOverride ?? appStateEffort)
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort)
    return { message: `Effort level: auto (currently ${level})` }
  }
  const description = getEffortValueDescription(effectiveValue)
  return {
    message: `Current effort level: ${effectiveValue} (${description})`,
  }
}

function unsetEffortLevel(): EffortCommandResult {
  unpinOpus47LaunchEffort()
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined,
  })
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`,
    }
  }
  logEvent('tengu_effort_command', {
    effort:
      'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: { value: undefined },
    }
  }
  return {
    message: 'Effort level set to max',
    effortUpdate: { value: undefined },
  }
}

export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase()
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel()
  }

  if (!isEffortLevel(normalized)) {
    return {
      message: `Invalid argument: ${args}. Valid options are: low, medium, high, xhigh, max, auto`,
    }
  }

  return setEffortValue(normalized)
}

function ShowCurrentEffort({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const effortValue = useAppState(s => s.effortValue)
  const model = useMainLoopModel()
  const { message } = showCurrentEffort(effortValue, model)
  onDone(message)
  return null
}

function ApplyEffortAndClose({
  result,
  onDone,
}: {
  result: EffortCommandResult
  onDone: (result: string) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const { effortUpdate, message } = result
  React.useEffect(() => {
    if (effortUpdate) {
      setAppState(prev => ({
        ...prev,
        effortValue: effortUpdate.value,
      }))
    }
    onDone(message)
  }, [setAppState, effortUpdate, message, onDone])
  return null
}

function RainbowEffortLabel({ text }: { text: string }): React.ReactNode {
  const [, time] = useAnimationFrame(100)
  const offset = Math.floor(time / 100)
  return (
    <Text bold>
      {[...text].map((ch, i) => (
        <Text key={i} color={getRainbowColor(i + offset)}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}

function ShimmerEffortLabel({ text }: { text: string }): React.ReactNode {
  const [, time] = useAnimationFrame(100)
  const cycle = text.length + 4
  const pos = Math.floor(time / 100) % cycle
  return (
    <Text bold>
      {[...text].map((ch, i) => {
        const hot = i === pos
        const near = i === pos - 1 || i === pos + 1
        return (
          <Text
            key={i}
            color={hot ? XHIGH_SHIMMER : 'autoAccept'}
            bold={hot || near}
          >
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

function SliderLevelLabel({
  level,
  selected,
}: {
  level: (typeof SLIDER_LEVELS)[number]
  selected: boolean
}): React.ReactNode {
  if (!selected) {
    return <Text>{level.value}</Text>
  }
  if (level.color === 'rainbow-animated') {
    return <RainbowEffortLabel text={level.value} />
  }
  if (level.color === 'autoAccept-shimmer') {
    return <ShimmerEffortLabel text={level.value} />
  }
  return (
    <Text bold color={level.color}>
      {level.value}
    </Text>
  )
}

function EffortSlider({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const current = useAppState(s => s.effortValue)
  const setAppState = useSetAppState()
  const initialIndex = React.useMemo(() => {
    if (typeof current !== 'string') return DEFAULT_SLIDER_INDEX
    const idx = SLIDER_LEVELS.findIndex(level => level.value === current)
    return idx === -1 ? DEFAULT_SLIDER_INDEX : idx
  }, [current])
  const [index, setIndex] = React.useState(initialIndex)

  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- official 111 slider uses raw arrows/enter/esc
  useInput((input, key) => {
    if (key.leftArrow) {
      setIndex(i => Math.max(0, i - 1))
    } else if (key.rightArrow) {
      setIndex(i => Math.min(SLIDER_LEVELS.length - 1, i + 1))
    } else if (key.return) {
      const level = SLIDER_LEVELS[index]
      if (!level) return
      const result = setEffortValue(level.value)
      if (result.effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: result.effortUpdate!.value,
        }))
      }
      onDone(result.message)
    } else if (key.escape || (key.ctrl && (input === 'c' || input === 'd'))) {
      onDone('Cancelled')
    }
  })

  const pointerAt = POINTER_AT[index] ?? 1
  const leftTrack = '─'.repeat(pointerAt)
  const rightTrack = '─'.repeat(TRACK_WIDTH - pointerAt - 1)
  const headerPad = ' '.repeat(TRACK_WIDTH - 5 - 12)

  return (
    <Box flexDirection="column">
      <Box height={1} />
      <Box flexDirection="column" alignItems="center" width="100%">
        <Box>
          <Text>Faster</Text>
          <Text>{headerPad}</Text>
          <Text>Smarter</Text>
        </Box>
        <Box>
          <Text dimColor>{leftTrack}</Text>
          <Text bold>▲</Text>
          <Text dimColor>{rightTrack}</Text>
        </Box>
        <Box>
          {SLIDER_LEVELS.map((level, i) => (
            <React.Fragment key={level.value}>
              <SliderLevelLabel level={level} selected={i === index} />
              {i < LABEL_GAPS.length ? (
                <Text>{' '.repeat(LABEL_GAPS[i]!)}</Text>
              ) : null}
            </React.Fragment>
          ))}
        </Box>
      </Box>
      <Box height={2} />
      <Text dimColor>←/→ to change effort · Enter to confirm</Text>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Usage: /effort [low|medium|high|xhigh|max|auto]\n\nEffort levels:\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- xhigh: Extended reasoning with thorough analysis (Opus 4.8/4.7 only)\n- max: Maximum capability with deepest reasoning (Opus 4.6+, Sonnet 4.6)\n- auto: Use the default effort level for your model',
    )
    return
  }

  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />
  }

  if (!args) {
    return <EffortSlider onDone={onDone} />
  }

  const result = executeEffort(args)
  return <ApplyEffortAndClose result={result} onDone={onDone} />
}
