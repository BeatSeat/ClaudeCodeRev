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
  isUltracodeEffortAvailable,
  parseEffortArg,
  parseEffortLevel,
  toPersistableEffort,
  unpinOpus47LaunchEffort,
} from '../../utils/effort.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { getRainbowColor } from '../../utils/thinking.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']

type SliderColor =
  | 'warning'
  | 'success'
  | 'permission'
  | 'autoAccept-shimmer'
  | 'rainbow-animated'
  | 'violet-ripple'

type SliderStop = { value: EffortLevel | 'ultracode'; color: SliderColor }

const SLIDER_LEVELS: SliderStop[] = [
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
  effortUpdate?: { value: EffortValue | undefined; ultracode?: boolean }
}

const XHIGH_MODEL_HINT = 'Fable 5, Opus 4.8/4.7 only'
const MAX_MODEL_HINT = 'Fable 5, Opus 4.6+, Sonnet 4.6'

function effortHelpText(): string {
  const offerUltracode = isUltracodeEffortAvailable(getMainLoopModel())
  return `Usage: /effort [low|medium|high|xhigh|max${offerUltracode ? '|ultracode' : ''}|auto]

Effort levels:
- low: Quick, straightforward implementation
- medium: Balanced approach with standard testing
- high: Comprehensive implementation with extensive testing
- xhigh: Extended reasoning with thorough analysis (${XHIGH_MODEL_HINT})
- max: Maximum capability with deepest reasoning (${MAX_MODEL_HINT})
${offerUltracode ? '- ultracode: xhigh + dynamic workflow orchestration (this session only)\n' : ''}- auto: Use the default effort level for your model`
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
        effortUpdate: { value: effortValue, ultracode: false },
      }
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: { value: effortValue, ultracode: false },
    }
  }

  const description = getEffortValueDescription(effortValue)
  const suffix = persistable !== undefined ? '' : ' (this session only)'
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: { value: effortValue, ultracode: false },
  }
}

/** Official 2.1.160 `qVA` — split workflows vs model blame. */
function setUltracodeEffort(): EffortCommandResult {
  if (!isUltracodeEffortAvailable()) {
    return {
      message:
        'Ultracode needs dynamic workflows enabled (see /config). Valid options are: low, medium, high, xhigh, max, auto',
    }
  }
  const model = getMainLoopModel()
  if (!isUltracodeEffortAvailable(model)) {
    return {
      message: `Ultracode runs at xhigh effort, which ${model} doesn't support — switch to an xhigh-capable model (${XHIGH_MODEL_HINT}). Valid options are: low, medium, high, xhigh, max, auto`,
    }
  }
  unpinOpus47LaunchEffort()
  const persistable = toPersistableEffort('xhigh')
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
    effort: 'ultracode' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== 'xhigh') {
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} overrides effort this session — clear it and ultracode takes over`,
      effortUpdate: { value: 'xhigh', ultracode: true },
    }
  }
  return {
    message:
      'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
    effortUpdate: { value: 'xhigh', ultracode: true },
  }
}

export function showCurrentEffort(
  appStateEffort: EffortValue | undefined,
  model: string,
  ultracode?: boolean,
): EffortCommandResult {
  const envOverride = getEffortEnvOverride()
  const effectiveValue =
    envOverride === null ? undefined : (envOverride ?? appStateEffort)
  if (ultracode && effectiveValue === 'xhigh') {
    return {
      message:
        'Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)',
    }
  }
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
      effortUpdate: { value: undefined, ultracode: false },
    }
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: { value: undefined, ultracode: false },
  }
}

export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase()
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel()
  }
  if (normalized === 'ultracode') {
    return setUltracodeEffort()
  }

  const level = parseEffortLevel(args)
  if (!level) {
    const offerUltracode = isUltracodeEffortAvailable(getMainLoopModel())
    return {
      message: `Invalid argument: ${args}. Valid options are: low, medium, high, xhigh, max,${offerUltracode ? ' ultracode,' : ''} auto`,
    }
  }

  return setEffortValue(level)
}

function ShowCurrentEffort({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const effortValue = useAppState(s => s.effortValue)
  const ultracode = useAppState(s => s.ultracode)
  const model = useMainLoopModel()
  const { message } = showCurrentEffort(effortValue, model, ultracode)
  onDone(message)
  return null
}

function ApplyEffortAndClose({
  result,
  parsed,
  onDone,
}: {
  result: EffortCommandResult
  parsed?: { value: EffortValue | undefined } | null
  onDone: (result: string) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const { effortUpdate, message } = result
  React.useEffect(() => {
    // Official zVA: if (confirmNeeded && parsed !== null) return pq$; else OKq.
    // This tree has no effort confirm dialog — always apply. `parsed` is eTA.
    void parsed
    if (effortUpdate) {
      setAppState(prev => ({
        ...prev,
        effortValue: effortUpdate.value,
        ultracode: effortUpdate.ultracode ?? false,
      }))
    }
    onDone(message)
  }, [setAppState, effortUpdate, message, onDone, parsed])
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
  if (level.color === 'violet-ripple') {
    return (
      <Text bold color="rainbow_violet">
        {level.value}
      </Text>
    )
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
  const ultracode = useAppState(s => s.ultracode)
  const model = useMainLoopModel()
  const setAppState = useSetAppState()
  const levels = React.useMemo((): SliderStop[] => {
    if (!isUltracodeEffortAvailable(model)) {
      return SLIDER_LEVELS
    }
    return [
      ...SLIDER_LEVELS,
      { value: 'ultracode', color: 'violet-ripple' },
    ]
  }, [model])
  const initialIndex = React.useMemo(() => {
    if (ultracode) {
      const idx = levels.findIndex(level => level.value === 'ultracode')
      return idx === -1 ? DEFAULT_SLIDER_INDEX : idx
    }
    if (typeof current !== 'string') return DEFAULT_SLIDER_INDEX
    const idx = levels.findIndex(level => level.value === current)
    return idx === -1 ? DEFAULT_SLIDER_INDEX : idx
  }, [current, ultracode, levels])
  const [index, setIndex] = React.useState(initialIndex)

  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- official 111 slider uses raw arrows/enter/esc
  useInput((input, key) => {
    if (key.leftArrow) {
      setIndex(i => Math.max(0, i - 1))
    } else if (key.rightArrow) {
      setIndex(i => Math.min(levels.length - 1, i + 1))
    } else if (key.return) {
      const level = levels[index]
      if (!level) return
      const result =
        level.value === 'ultracode'
          ? setUltracodeEffort()
          : setEffortValue(level.value)
      if (result.effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: result.effortUpdate!.value,
          ultracode: result.effortUpdate!.ultracode ?? false,
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
          {levels.map((level, i) => (
            <React.Fragment key={level.value}>
              <SliderLevelLabel level={level} selected={i === index} />
              {i < levels.length - 1 ? (
                <Text>{' '.repeat(LABEL_GAPS[i] ?? 2)}</Text>
              ) : null}
            </React.Fragment>
          ))}
        </Box>
        {isUltracodeEffortAvailable(model) ? (
          <Text dimColor>xhigh + workflows</Text>
        ) : null}
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
    onDone(effortHelpText())
    return
  }

  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />
  }

  if (!args) {
    return <EffortSlider onDone={onDone} />
  }

  // Official zVA: eTA(args, currentModel) cached on args+model, then OKq/gh8.
  const parsed = parseEffortArg(args, getMainLoopModel())
  const result = executeEffort(args)
  return <ApplyEffortAndClose result={result} parsed={parsed} onDone={onDone} />
}
