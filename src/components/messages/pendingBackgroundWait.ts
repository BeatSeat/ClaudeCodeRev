import { isPanelAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'

function isTerminalStatus(status: TaskState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * Official 2.1.152 `Np6`: count unfinished background agents and local
 * workflows (running, or terminal but not yet notified).
 */
export function countPendingBackgroundWork({
  tasks,
  queuedCommands = [],
}: {
  tasks: Record<string, TaskState>
  queuedCommands?: readonly QueuedCommand[]
}): { pendingAgents: number; pendingWorkflows: number } {
  const pendingAgents = new Set<string>()
  const pendingWorkflows = new Set<string>()

  const add = (task: TaskState): void => {
    if (isPanelAgentTask(task) && task.isBackgrounded) {
      pendingAgents.add(task.id)
    } else if (task.type === 'local_workflow') {
      pendingWorkflows.add(task.id)
    }
  }

  for (const task of Object.values(tasks)) {
    if (task.status === 'running' || (isTerminalStatus(task.status) && !task.notified)) {
      add(task)
    }
  }
  for (const cmd of queuedCommands) {
    if (
      cmd.mode !== 'task-notification' ||
      cmd.agentId !== undefined ||
      cmd.taskId === undefined
    ) {
      continue
    }
    const task = tasks[cmd.taskId]
    if (task) add(task)
  }

  return { pendingAgents: pendingAgents.size, pendingWorkflows: pendingWorkflows.size }
}

export type TurnDurationWaitFields = {
  durationMs: number
  pendingBackgroundAgentCount: number | undefined
  pendingWorkflowCount: number | undefined
  backgroundWaitStartTime: number | null
}

/**
 * Official 2.1.152 `I14`: while agents/workflows are still pending, keep the
 * original turn duration and stamp wait-start; once they finish, duration is
 * the wait-only interval.
 */
export function computeTurnDurationWait({
  tasks,
  queuedCommands = [],
  turnDurationMs,
  turnStartTime,
  now,
  backgroundWaitStartTime,
}: {
  tasks: Record<string, TaskState>
  queuedCommands?: readonly QueuedCommand[]
  turnDurationMs: number
  turnStartTime: number
  now: number
  backgroundWaitStartTime: number | null
}): TurnDurationWaitFields {
  const { pendingAgents, pendingWorkflows } = countPendingBackgroundWork({
    tasks,
    queuedCommands,
  })
  if (pendingAgents > 0 || pendingWorkflows > 0) {
    return {
      durationMs: turnDurationMs,
      pendingBackgroundAgentCount: pendingAgents > 0 ? pendingAgents : undefined,
      pendingWorkflowCount: pendingWorkflows > 0 ? pendingWorkflows : undefined,
      backgroundWaitStartTime: backgroundWaitStartTime ?? turnStartTime,
    }
  }
  return {
    durationMs: backgroundWaitStartTime !== null ? now - backgroundWaitStartTime : turnDurationMs,
    pendingBackgroundAgentCount: undefined,
    pendingWorkflowCount: undefined,
    backgroundWaitStartTime: null,
  }
}
