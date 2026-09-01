import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { enterTeammateView } from '../../state/teammateViewHelpers.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { truncateToWidth } from '../../utils/format.js'
import { StatusIcon } from '../design-system/StatusIcon.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'

type Props = {
  onExit: () => void
}

function isRunningAgent(task: LocalAgentTaskState): boolean {
  return (
    task.agentType !== 'main-session' &&
    task.status !== 'completed' &&
    task.status !== 'failed' &&
    task.status !== 'killed'
  )
}

function isFinishedAgent(task: LocalAgentTaskState): boolean {
  return (
    task.agentType !== 'main-session' &&
    (task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'killed')
  )
}

function completedSummary(task: LocalAgentTaskState): string {
  const text =
    task.result?.content?.[0]?.text ?? task.error ?? task.description
  return truncateToWidth(text, 60)
}

/** Official 2.1.98 VcK — Running tab for /agents. */
export function AgentsRunningTab({ onExit }: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks)
  const agentNameRegistry = useAppState(s => s.agentNameRegistry)
  const setAppState = useSetAppState()
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [, setTick] = useState(0)

  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const [name, id] of agentNameRegistry) {
      map.set(id, name)
    }
    return map
  }, [agentNameRegistry])

  const running = useMemo(
    () =>
      Object.values(tasks)
        .filter(isLocalAgentTask)
        .filter(isRunningAgent)
        .sort((a, b) => a.startTime - b.startTime),
    [tasks],
  )
  const recent = useMemo(
    () =>
      Object.values(tasks)
        .filter(isLocalAgentTask)
        .filter(isFinishedAgent)
        .sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0))
        .slice(0, 5),
    [tasks],
  )
  const rows = useMemo(() => [...running, ...recent], [running, recent])

  useEffect(() => {
    if (running.length === 0) return
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [running.length])

  const selectedIndex = rows.findIndex(row => row.id === selectedId)
  const selected =
    selectedIndex >= 0
      ? rows[selectedIndex]
      : selectedId === undefined
        ? rows[0]
        : undefined

  useEffect(() => {
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id)
    }
  }, [selected, selectedId])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (headerFocused) return
    if (selectedId !== undefined && selectedIndex < 0) {
      if (e.key === 'up' || e.key === 'down') {
        e.preventDefault()
        setSelectedId(rows[0]?.id)
      }
      return
    }
    const index = selectedIndex < 0 ? 0 : selectedIndex
    if (e.key === 'up') {
      e.preventDefault()
      if (index === 0 || rows.length === 0) {
        focusHeader()
      } else {
        setSelectedId(rows[index - 1]?.id)
      }
      return
    }
    if (e.key === 'down') {
      e.preventDefault()
      setSelectedId(rows[Math.min(index + 1, rows.length - 1)]?.id)
      return
    }
    if (!selected) return
    if (e.key === 'return') {
      e.preventDefault()
      enterTeammateView(selected.id, setAppState)
      onExit()
      return
    }
    if (e.key === 'x' && selected.status === 'running') {
      e.preventDefault()
      selected.abortController?.abort()
    }
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {rows.length === 0 && (
        <Text dimColor>No subagents are currently running.</Text>
      )}
      {running.map(task => {
        const isSelected = task.id === selected?.id && !headerFocused
        const name = nameById.get(task.id)
        const summary = truncateToWidth(
          task.progress?.summary || task.description,
          50,
        )
        const elapsed = formatDuration(
          Math.max(
            0,
            Date.now() - task.startTime - (task.totalPausedMs ?? 0),
          ),
        )
        const tokens = task.progress?.tokenCount
        return (
          <Box key={task.id}>
            <Text color={isSelected ? 'suggestion' : undefined}>
              {isSelected ? `${figures.pointer} ` : '  '}
              <Text color="success">{BLACK_CIRCLE}</Text>{' '}
              <Text bold>{name || task.agentType}</Text>
              {name && <Text dimColor> · {task.agentType}</Text>}
              <Text dimColor> · {summary}</Text>
              <Text dimColor> · {elapsed}</Text>
              {tokens !== undefined && tokens > 0 && (
                <Text dimColor> · {formatTokens(tokens)} tokens</Text>
              )}
              {isSelected && <Text dimColor> · x to stop</Text>}
            </Text>
          </Box>
        )
      })}
      {recent.length > 0 && (
        <>
          <Box marginTop={running.length > 0 ? 1 : 0}>
            <Text bold dimColor>
              Recently completed
            </Text>
          </Box>
          {recent.map(task => {
            const isSelected = task.id === selected?.id && !headerFocused
            const name = nameById.get(task.id)
            return (
              <Box key={task.id}>
                <Text
                  color={isSelected ? 'suggestion' : undefined}
                  dimColor={!isSelected}
                >
                  {isSelected ? `${figures.pointer} ` : '  '}
                  <StatusIcon
                    status={task.status === 'completed' ? 'success' : 'error'}
                    withSpace
                  />
                  <Text bold>{name || task.agentType}</Text>
                  <Text dimColor> · {completedSummary(task)}</Text>
                </Text>
              </Box>
            )
          })}
        </>
      )}
    </Box>
  )
}
