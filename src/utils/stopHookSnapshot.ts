import { getSessionCronTasks } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import { isBackgroundTask, type TaskState } from '../tasks/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../tasks/LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from '../tasks/MonitorMcpTask/MonitorMcpTask.js'

const STOP_HOOK_CLIP_LIMIT = 1000

const TASK_TYPE_LABEL: Record<string, string> = {
  local_agent: 'subagent',
  local_workflow: 'workflow',
  local_bash: 'shell',
  monitor_mcp: 'monitor',
  mcp_task: 'MCP task',
  in_process_teammate: 'teammate',
  dream: 'dream',
  remote_agent: 'cloud session',
}

/** Official 2.1.145 `hy8` + `CE$`: UTF-16 clip with surrogate-pair guard. */
export function clipStopHookText(value: string, max = STOP_HOOK_CLIP_LIMIT): string {
  if (value.length <= max) return value
  let clipped = value.slice(0, max)
  const last = clipped.charCodeAt(max - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    clipped = clipped.slice(0, -1)
  }
  return `${clipped}\u2026 [+${value.length - clipped.length} chars]`
}

export type StopHookBackgroundTask = {
  id: string
  type: string
  status: string
  description: string
  command?: string
  agent_type?: string
  server?: string
  tool?: string
  name?: string
}

export type StopHookSessionCron = {
  id: string
  schedule: string
  recurring: boolean
  prompt: string
}

/** Official 2.1.145 `SR4`. */
export function projectStopHookBackgroundTasks(
  tasks: AppState['tasks'] | undefined,
): StopHookBackgroundTask[] {
  if (!tasks) return []
  const out: StopHookBackgroundTask[] = []
  for (const raw of Object.values(tasks)) {
    const task = raw as TaskState
    if (!isBackgroundTask(task)) continue
    // Union members do not share TaskStateBase in this tree's checker;
    // read the official SR4 fields through a structural view.
    const view = task as unknown as {
      id: string
      type: string
      status: string
      description: string
    }
    const row: StopHookBackgroundTask = {
      id: view.id,
      type: TASK_TYPE_LABEL[view.type] ?? view.type,
      status: view.status,
      description: clipStopHookText(view.description),
    }
    switch (view.type) {
      case 'local_bash':
        row.command = clipStopHookText((task as LocalShellTaskState).command)
        break
      case 'local_agent':
        row.agent_type = (task as LocalAgentTaskState).agentType
        break
      case 'monitor_mcp': {
        const monitor = task as MonitorMcpTaskState & {
          server?: string
          tool?: string
        }
        row.server = monitor.server ?? monitor.serverName
        row.tool = monitor.tool
        break
      }
      case 'local_workflow':
        row.name = (task as LocalWorkflowTaskState).workflowName
        break
      default:
        break
    }
    out.push(row)
  }
  return out
}

/** Official 2.1.145 `IR4`. */
export function projectStopHookSessionCrons(): StopHookSessionCron[] {
  return getSessionCronTasks().map(task => ({
    id: task.id,
    schedule: task.cron,
    recurring: task.recurring ?? false,
    prompt: clipStopHookText(task.prompt),
  }))
}
