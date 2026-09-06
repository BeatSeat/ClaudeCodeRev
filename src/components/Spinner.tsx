// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../ink.js'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  computeGlimmerIndex,
  computeShimmerSegments,
  SHIMMER_INTERVAL_MS,
} from '../bridge/bridgeStatusUtil.js'
import { feature } from 'bun:bundle'
import { getKairosActive, getUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { count } from '../utils/array.js'
import sample from 'lodash-es/sample.js'
import { formatNumber, formatDuration } from '../utils/format.js'
import type { Theme } from 'src/utils/theme.js'
import { activityManager } from '../utils/activityManager.js'
import { getSpinnerVerbs } from '../constants/spinnerVerbs.js'
import { MessageResponse } from './MessageResponse.js'
import { TaskListV2 } from './TaskListV2.js'
import { useTasksV2 } from '../hooks/useTasksV2.js'
import type { Task } from '../utils/tasks.js'
import { useAppState } from '../state/AppState.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { getDefaultCharacters, type SpinnerMode } from './Spinner/index.js'
import { syncThinkingStartedAt } from './Spinner/thinkingStartedAt.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { useSettings } from '../hooks/useSettings.js'
import { isBackgroundTask } from '../tasks/types.js'
import { getEffortSuffix } from '../utils/effort.js'
import { getMainLoopModel } from '../utils/model/model.js'
import figures from 'figures'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
} from '../bootstrap/state.js'

import { hasExcludeDefaultSpinnerTips } from '../services/tips/tipRegistry.js'
import { useAnimationFrame } from '../ink.js'
import { getGlobalConfig } from '../utils/config.js'
export type { SpinnerMode } from './Spinner/index.js'

const DEFAULT_CHARACTERS = getDefaultCharacters()

const SPINNER_FRAMES = [
  ...DEFAULT_CHARACTERS,
  ...[...DEFAULT_CHARACTERS].reverse(),
]


type Props = {
  mode: SpinnerMode
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  spinnerTip?: string
  responseLengthRef: React.RefObject<number>
  overrideColor?: keyof Theme | null
  overrideShimmerColor?: keyof Theme | null
  overrideMessage?: string | null
  spinnerSuffix?: string | null
  verbose: boolean
  hasActiveTools?: boolean
  /** Per-agent default verb from the spinner store (official `v5f` `defaultVerb`). */
  defaultVerb?: string
  /**
   * Agent whose turn this spinner represents. When set to a non-main agent id,
   * next-task / expanded todo UI is suppressed (official `v5f` `agentId` / `RK()`).
   */
  agentId?: string
}

// Thin wrapper: branches on isBriefOnly so the two variants have independent
// hook call chains. Without this split, toggling /brief mid-render would
// violate Rules of Hooks (the inner variant calls ~10 more hooks).
export function SpinnerWithVerb(props: Props): React.ReactNode {
  const isBriefOnly = useAppState(s => s.isBriefOnly)
  // REPL overrides isBriefOnly→false when viewing a teammate transcript
  // (see isBriefOnly={viewedTeammateTask ? false : isBriefOnly}). That
  // prop isn't threaded here, so replicate the gate from the store —
  // teammate view needs the real spinner (which shows teammate status).
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  // Hoisted to mount-time — this component re-renders at animation framerate.
  const briefEnvEnabled =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_BRIEF), [])
      : false

  // Runtime gate mirrors isBriefEnabled() but inlined — importing from
  // BriefTool.ts would leak tool-name strings into external builds. Single
  // spinner instance → hooks stay unconditional (two subs, negligible).
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    (getKairosActive() ||
      (getUserMsgOptIn() &&
        (briefEnvEnabled ||
          getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_brief', false)))) &&
    isBriefOnly &&
    !viewingAgentTaskId
  ) {
    return (
      <BriefSpinner mode={props.mode} overrideMessage={props.overrideMessage} />
    )
  }

  return <SpinnerWithVerbInner {...props} />
}

/** Official 2.1.179 `UWf`→`v5f`. */
function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  defaultVerb,
  agentId,
}: Props): React.ReactNode {
  const settings = useSettings()
  const reducedMotion = settings.prefersReducedMotion ?? false

  const expandedView = useAppState(s => s.expandedView)
  const showExpandedTodos = expandedView === 'tasks'
  const { columns } = useTerminalSize()
  const tasksV2 = useTasksV2()

  const [thinkingStatus, setThinkingStatus] = useState<
    'thinking' | number | null
  >(null)
  const thinkingStartRef = useRef<number | null>(null)

  useEffect(() => {
    syncThinkingStartedAt(mode)
  }, [mode])

  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null

    if (mode === 'thinking') {
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now()
        setThinkingStatus('thinking')
      }
    } else if (thinkingStartRef.current !== null) {
      const duration = Date.now() - thinkingStartRef.current
      const elapsed = Date.now() - thinkingStartRef.current
      const remainingThinkingTime = Math.max(0, 2000 - elapsed)

      thinkingStartRef.current = null

      const showDuration = (): void => {
        setThinkingStatus(duration)
        clearStatusTimer = setTimeout(setThinkingStatus, 2000, null)
      }

      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime)
      } else {
        showDuration()
      }
    }

    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer)
      if (clearStatusTimer) clearTimeout(clearStatusTimer)
    }
  }, [mode])

  // Official `v5f`: `L===void 0||L===RK()` — undefined agentId ≈ main.
  const isCurrentAgent = agentId === undefined
  const currentTodo = isCurrentAgent
    ? tasksV2?.find(
        task => task.status !== 'pending' && task.status !== 'completed',
      )
    : undefined
  const nextTask = isCurrentAgent ? findNextPendingTask(tasksV2) : undefined

  const [randomVerb] = useState(() => sample(getSpinnerVerbs()))

  // Official `v5f`: g=(A??C?.activeForm??C?.subject??(X||U))+"…"
  const message =
    (overrideMessage ??
      currentTodo?.activeForm ??
      currentTodo?.subject ??
      (defaultVerb || randomVerb)) +
    '…'

  useEffect(() => {
    const operationId = 'spinner-' + mode
    activityManager.startCLIActivity(operationId)
    return () => {
      activityManager.endCLIActivity(operationId)
    }
  }, [mode])

  const effortValue = useAppState(s => s.effortValue)
  const effortSuffix = getEffortSuffix(getMainLoopModel(), effortValue)

  const elapsedSnapshot =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current -
        loadingStartTimeRef.current -
        totalPausedMsRef.current
      : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current

  const defaultColor: keyof Theme = 'claude'
  const defaultShimmerColor = 'claudeShimmer'
  const messageColor = overrideColor ?? defaultColor
  const shimmerColor = overrideShimmerColor ?? defaultShimmerColor

  let contextTipsActive = false
  const tipsEnabled = settings.spinnerTipsEnabled !== false
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000
  const showBtwTip =
    tipsEnabled && elapsedSnapshot > 30_000 && !getGlobalConfig().btwUseCount

  const effectiveTip = contextTipsActive
    ? undefined
    : hasExcludeDefaultSpinnerTips(settings.spinnerTipsOverride)
      ? spinnerTip
      : showClearTip && !nextTask
        ? 'Use /clear to start fresh when switching topics and free up context'
        : showBtwTip && !nextTask
          ? "Use /btw to ask a quick side question without interrupting Claude's current work"
          : spinnerTip

  let budgetText: string | null = null
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget !== null && budget > 0) {
      const tokens = getTurnOutputTokens()
      if (tokens >= budget) {
        budgetText = `Target: ${formatNumber(tokens)} used (${formatNumber(budget)} min ${figures.tick})`
      } else {
        const pct = Math.round((tokens / budget) * 100)
        const remaining = budget - tokens
        const rate =
          elapsedSnapshot > 5000 && tokens >= 2000
            ? tokens / elapsedSnapshot
            : 0
        const eta =
          rate > 0
            ? ` \u00B7 ~${formatDuration(remaining / rate, { mostSignificantOnly: true })}`
            : ''
        budgetText = `Target: ${formatNumber(tokens)} / ${formatNumber(budget)} (${pct}%)${eta}`
      }
    }
  }

  return (
    <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow
        mode={mode}
        reducedMotion={reducedMotion}
        hasActiveTools={hasActiveTools}
        responseLengthRef={responseLengthRef}
        message={message}
        messageColor={messageColor}
        shimmerColor={shimmerColor}
        overrideColor={overrideColor}
        loadingStartTimeRef={loadingStartTimeRef}
        totalPausedMsRef={totalPausedMsRef}
        pauseStartTimeRef={pauseStartTimeRef}
        spinnerSuffix={spinnerSuffix}
        verbose={verbose}
        columns={columns}
        thinkingStatus={thinkingStatus}
        effortSuffix={effortSuffix}
      />
      {isCurrentAgent && showExpandedTodos && tasksV2 && tasksV2.length > 0 ? (
        <Box width="100%" flexDirection="column">
          <MessageResponse>
            <TaskListV2 tasks={tasksV2} />
          </MessageResponse>
        </Box>
      ) : nextTask || effectiveTip || budgetText ? (
        <Box width="100%" flexDirection="column">
          {budgetText && (
            <MessageResponse>
              <Text dimColor>{budgetText}</Text>
            </MessageResponse>
          )}
          {(nextTask || effectiveTip) && (
            <MessageResponse>
              <Text dimColor>
                {nextTask
                  ? `Next: ${nextTask.subject}`
                  : `Tip: ${effectiveTip}`}
              </Text>
            </MessageResponse>
          )}
        </Box>
      ) : null}
    </Box>
  )
}

type BriefSpinnerProps = {
  mode: SpinnerMode
  overrideMessage?: string | null
}

function BriefSpinner({
  mode,
  overrideMessage,
}: BriefSpinnerProps): React.ReactNode {
  const settings = useSettings()
  const reducedMotion = settings.prefersReducedMotion ?? false
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()) ?? 'Working')
  const verb = overrideMessage ?? randomVerb
  const connStatus = useAppState(s => s.remoteConnectionStatus)

  useEffect(() => {
    const operationId = 'spinner-' + mode
    activityManager.startCLIActivity(operationId)
    return () => {
      activityManager.endCLIActivity(operationId)
    }
  }, [mode])

  const [, time] = useAnimationFrame(reducedMotion ? null : 120)

  const runningCount = useAppState(
    s =>
      count(Object.values(s.tasks), isBackgroundTask) +
      s.remoteBackgroundTaskCount,
  )

  const showConnWarning =
    connStatus === 'reconnecting' || connStatus === 'disconnected'
  const connText =
    connStatus === 'reconnecting' ? 'Reconnecting' : 'Disconnected'

  const dotFrame = Math.floor(time / 300) % 3
  const dots = reducedMotion ? '…  ' : '.'.repeat(dotFrame + 1).padEnd(3)

  const verbWidth = useMemo(() => stringWidth(verb), [verb])
  const glimmerIndex =
    reducedMotion || showConnWarning
      ? -100
      : computeGlimmerIndex(Math.floor(time / SHIMMER_INTERVAL_MS), verbWidth)
  const { before, shimmer, after } = computeShimmerSegments(verb, glimmerIndex)

  const { columns } = useTerminalSize()
  const rightText = runningCount > 0 ? `${runningCount} in background` : ''
  const leftWidth = (showConnWarning ? stringWidth(connText) : verbWidth) + 3
  const pad = Math.max(1, columns - 2 - leftWidth - stringWidth(rightText))

  return (
    <Box flexDirection="row" width="100%" marginTop={1} paddingLeft={2}>
      {showConnWarning ? (
        <Text color="error">{connText + dots}</Text>
      ) : (
        <>
          {before ? <Text dimColor>{before}</Text> : null}
          {shimmer ? <Text>{shimmer}</Text> : null}
          {after ? <Text dimColor>{after}</Text> : null}
          <Text dimColor>{dots}</Text>
        </>
      )}
      {rightText ? (
        <>
          <Text>{' '.repeat(pad)}</Text>
          <Text color="subtle">{rightText}</Text>
        </>
      ) : null}
    </Box>
  )
}

export function BriefIdleStatus(): React.ReactNode {
  const connStatus = useAppState(s => s.remoteConnectionStatus)
  const runningCount = useAppState(
    s =>
      count(Object.values(s.tasks), isBackgroundTask) +
      s.remoteBackgroundTaskCount,
  )
  const { columns } = useTerminalSize()

  const showConnWarning =
    connStatus === 'reconnecting' || connStatus === 'disconnected'
  const connText =
    connStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'
  const leftText = showConnWarning ? connText : ''
  const rightText = runningCount > 0 ? `${runningCount} in background` : ''

  if (!leftText && !rightText) return <Box height={2} />

  const pad = Math.max(
    1,
    columns - 2 - stringWidth(leftText) - stringWidth(rightText),
  )
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text>
        {leftText ? <Text color="error">{leftText}</Text> : null}
        {rightText ? (
          <>
            <Text>{' '.repeat(pad)}</Text>
            <Text color="subtle">{rightText}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  )
}

export function Spinner(): React.ReactNode {
  const settings = useSettings()
  const reducedMotion = settings.prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120)

  if (reducedMotion) {
    return (
      <Box ref={ref} flexWrap="wrap" height={1} width={2}>
        <Text color="text">●</Text>
      </Box>
    )
  }

  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length

  return (
    <Box ref={ref} flexWrap="wrap" height={1} width={2}>
      <Text color="text">{SPINNER_FRAMES[frame]}</Text>
    </Box>
  )
}


function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending')
  if (pendingTasks.length === 0) {
    return undefined
  }
  const unresolvedIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )
  return (
    pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ??
    pendingTasks[0]
  )
}
