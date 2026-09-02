import * as React from 'react'
import { getTotalOutputTokens } from '../../bootstrap/state.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Box, Text, useInterval } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { firstLineOf, plural } from '../../utils/stringUtils.js'
import { findLastAchievedGoal } from './goal-core.js'
import type { AppStateWithGoal } from './types.js'

/** Official 2.1.139 nI$ */
const BULLSEYE = '\u25CE'

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text dimColor>{label}: </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{children}</Text>
      </Box>
    </Box>
  )
}

/**
 * Official 2.1.139 VZ4 — /goal overlay (active / achieved / empty).
 */
export function GoalOverlay({
  messages,
  onDone,
}: {
  messages: Message[]
  onDone: () => void
}): React.ReactNode {
  const activeGoal = useAppState(s => (s as AppStateWithGoal).activeGoal)
  const [, setTick] = React.useState(0)
  useInterval(() => setTick(n => n + 1), activeGoal ? 1000 : null)

  if (activeGoal) {
    const running = formatDuration(Date.now() - activeGoal.setAt, {
      mostSignificantOnly: true,
    })
    const turns =
      activeGoal.iterations > 0
        ? `${activeGoal.iterations} ${plural(activeGoal.iterations, 'turn')}`
        : undefined
    const tokens = `${formatTokens(getTotalOutputTokens() - activeGoal.tokensAtStart)} tokens`
    const subtitle = [`running ${running}`, turns, tokens]
      .filter(Boolean)
      .join(' \u00b7 ')
    return (
      <Dialog
        title={`${BULLSEYE} Goal active`}
        subtitle={subtitle}
        onCancel={onDone}
        inputGuide={() => (
          <Byline>
            <Text>/goal clear to stop early</Text>
            <KeyboardShortcutHint chord="escape" action="dismiss" />
          </Byline>
        )}
      >
        <Box flexDirection="column">
          <Field label="Goal">{activeGoal.condition}</Field>
          {activeGoal.lastReason ? (
            <Field label="Last check">
              {firstLineOf(activeGoal.lastReason.trim())}
            </Field>
          ) : null}
        </Box>
      </Dialog>
    )
  }

  const achieved = findLastAchievedGoal(messages)
  if (achieved) {
    const parts: string[] = []
    if (achieved.durationMs !== undefined) {
      parts.push(
        formatDuration(achieved.durationMs, { mostSignificantOnly: true }),
      )
    }
    if (achieved.iterations !== undefined) {
      parts.push(
        `${achieved.iterations} ${plural(achieved.iterations, 'turn')}`,
      )
    }
    if (achieved.tokens !== undefined) {
      parts.push(`${formatTokens(achieved.tokens)} tokens`)
    }
    return (
      <Dialog
        title={
          <Text>
            <StatusIcon status="success" withSpace />
            Goal achieved
          </Text>
        }
        subtitle={parts.join(' \u00b7 ')}
        color="success"
        onCancel={onDone}
        inputGuide={() => (
          <Byline>
            <Text>/goal {'<condition>'} to set another</Text>
            <KeyboardShortcutHint chord="escape" action="dismiss" />
          </Byline>
        )}
      >
        <Field label="Goal">{achieved.condition}</Field>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Goal"
      onCancel={onDone}
      inputGuide={() => (
        <KeyboardShortcutHint chord="escape" action="dismiss" />
      )}
    >
      <Box flexDirection="column">
        <Text>No goal set</Text>
        <Text dimColor>/goal {'<condition>'} to set one</Text>
      </Box>
    </Dialog>
  )
}
