import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { useAppState } from 'src/state/AppState.js'
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { getPillLabel, pillNeedsCta } from 'src/tasks/pillLabel.js'
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js'
import { Box, Text } from '../../ink.js'
import { shouldHideTasksFooter } from './taskStatusUtils.js'

type Props = {
  tasksSelected: boolean
  /** @deprecated Official 2.1.179 DCE'd teammate footer pills (`Ur8`). Kept optional for call-site churn. */
  isViewingTeammate?: boolean
  /** @deprecated Official 2.1.179 DCE'd with `teammateFooterIndex`. */
  teammateFooterIndex?: number
  /** @deprecated Official 2.1.179 DCE'd with `isLeaderIdle`. */
  isLeaderIdle?: boolean
  onOpenDialog?: (taskId?: string) => void
}

/**
 * Footer summary for background tasks.
 * Official 2.1.179 removed teammate `@name` pills / scroller (`Ur8`/`xPz`/`zm9`);
 * only the summary pill remains.
 */
export function BackgroundTaskStatus({
  tasksSelected,
  onOpenDialog,
}: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks)

  const runningTasks = useMemo(
    () =>
      (Object.values(tasks ?? {}) as TaskState[]).filter(
        t =>
          isBackgroundTask(t) &&
          !("external" === 'ant' && isPanelAgentTask(t)),
      ),
    [tasks],
  )

  if (shouldHideTasksFooter(tasks ?? {}, false)) {
    return null
  }

  if (runningTasks.length === 0) {
    return null
  }

  return (
    <>
      <SummaryPill selected={tasksSelected} onClick={onOpenDialog}>
        {getPillLabel(runningTasks)}
      </SummaryPill>
      {pillNeedsCta(runningTasks) && (
        <Text dimColor> · {figures.arrowDown} to view</Text>
      )}
    </>
  )
}

function SummaryPill({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.ReactNode {
  const [hover, setHover] = useState(false)
  const label = (
    <Text color="background" inverse={selected || hover}>
      {children}
    </Text>
  )
  if (!onClick) return label
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {label}
    </Box>
  )
}
