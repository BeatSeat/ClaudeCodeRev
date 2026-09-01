import { writeFile } from 'fs/promises'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, isTerminalTaskStatus } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { evictTaskOutput, initTaskOutput } from '../../utils/task/diskOutput.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  PANEL_GRACE_MS,
  registerTask,
  updateTaskState,
} from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'

/**
 * Official 2.1.153 `rm6` local_workflow task fields + progress events.
 */
export type WorkflowProgressEvent =
  | {
      type: 'workflow_agent'
      index: number
      state?: string
      label?: string
      phaseTitle?: string
      phaseIndex?: number
      tokens?: number
      toolCalls?: number
      durationMs?: number
      error?: string
      agentId?: string
      agentType?: string
      isolation?: string
      model?: string
      startedAt?: number
      queuedAt?: number
      lastProgressAt?: number
      cached?: boolean
      skipped?: boolean
      attempt?: number
      lastAttemptReason?: string
      lastToolName?: string
      lastToolSummary?: string
      resultPreview?: string
      promptPreview?: string
    }
  | {
      type: 'workflow_phase'
      index: number
      title?: string
      kind?: string
    }
  | {
      type: 'workflow_log'
      message: string
    }

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  script: string
  scriptPath?: string
  args?: unknown
  prompt: string
  summary?: string
  workflowName?: string
  title?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
  defaultModel?: string
  workflowRunId?: string
  workflowProgress: WorkflowProgressEvent[]
  progressVersion: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  logs: string[]
  result?: unknown
  error?: string
  abortController?: AbortController
  agentControllers?: Map<string, AbortController>
  evictAfter?: number
}

/** Official 2.1.153 `Lq4`. */
const WORKFLOW_LOG_TRIM_THRESHOLD = 500

/**
 * Official 2.1.153 taskRegistry adapter: register / update / all / remove.
 * There is no `taskRegistry` object in this tree.
 */
export type WorkflowTaskRegistry = {
  register(task: LocalWorkflowTaskState): void
  update(
    taskId: string,
    updater: (task: LocalWorkflowTaskState) => LocalWorkflowTaskState,
  ): void
  all(): { [taskId: string]: TaskState | LocalWorkflowTaskState }
  remove(taskId: string): void
  abortSpeculation(): void
}

export function createWorkflowTaskRegistry(
  getAppState: () => AppState,
  setAppState: SetAppState,
): WorkflowTaskRegistry {
  return {
    register(task) {
      registerTask(task, setAppState)
    },
    update(taskId, updater) {
      updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, updater)
    },
    all() {
      return getAppState().tasks ?? {}
    },
    remove(taskId) {
      setAppState(prev => {
        if (!prev.tasks[taskId]) {
          return prev
        }
        const { [taskId]: _removed, ...remaining } = prev.tasks
        return { ...prev, tasks: remaining }
      })
    },
    abortSpeculation() {
      abortSpeculation(setAppState)
    },
  }
}

/**
 * Official 2.1.153 `rm6`.
 */
export function registerLocalWorkflowTask({
  taskId,
  script,
  scriptPath,
  args,
  summary,
  workflowName,
  title,
  phases,
  defaultModel,
  workflowRunId,
  taskRegistry,
  toolUseId,
}: {
  taskId: string
  script: string
  scriptPath?: string
  args?: unknown
  summary?: string
  workflowName?: string
  title?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
  defaultModel?: string
  workflowRunId?: string
  taskRegistry: WorkflowTaskRegistry
  toolUseId?: string
}): LocalWorkflowTaskState {
  void initTaskOutput(taskId)
  const abortController = new AbortController()
  const task: LocalWorkflowTaskState = {
    ...createTaskStateBase(
      taskId,
      'local_workflow',
      summary ?? 'Dynamic workflow',
      toolUseId,
    ),
    type: 'local_workflow',
    status: 'running',
    script,
    scriptPath,
    args,
    prompt: script,
    summary,
    workflowName,
    title,
    phases,
    defaultModel,
    workflowRunId,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    abortController,
    agentControllers: new Map(),
  }
  taskRegistry.register(task)
  return task
}

/**
 * Official 2.1.153 `om6`.
 */
export function applyWorkflowProgress(
  taskId: string,
  events: WorkflowProgressEvent[],
  taskRegistry: WorkflowTaskRegistry,
): void {
  if (events.length === 0) {
    return
  }
  taskRegistry.update(taskId, task => {
    if (task.status !== 'running') {
      return task
    }
    let progress = [...task.workflowProgress]
    const keyed = new Map<string, number>()
    for (let i = 0; i < progress.length; i++) {
      const item = progress[i]
      if (
        item &&
        (item.type === 'workflow_agent' || item.type === 'workflow_phase')
      ) {
        keyed.set(`${item.type}:${item.index}`, i)
      }
    }
    let agentCount = task.agentCount
    let appendedLog = false
    for (const event of events) {
      if (event.type === 'workflow_agent' || event.type === 'workflow_phase') {
        const key = `${event.type}:${event.index}`
        const existing = keyed.get(key)
        if (existing !== undefined) {
          progress[existing] = event
        } else {
          keyed.set(key, progress.length)
          progress.push(event)
        }
        if (event.type === 'workflow_agent' && event.state === 'start') {
          agentCount = Math.max(agentCount, event.index)
        }
      } else {
        progress.push(event)
        appendedLog = true
      }
    }
    if (appendedLog && progress.length > WORKFLOW_LOG_TRIM_THRESHOLD * 2) {
      let drop = progress.length - WORKFLOW_LOG_TRIM_THRESHOLD
      const kept: WorkflowProgressEvent[] = []
      for (const item of progress) {
        if (drop > 0 && item.type === 'workflow_log') {
          drop--
          continue
        }
        kept.push(item)
      }
      progress = kept
    }
    let totalTokens = 0
    let totalToolCalls = 0
    for (const item of progress) {
      if (item.type === 'workflow_agent') {
        if (item.tokens) {
          totalTokens += item.tokens
        }
        if (item.toolCalls) {
          totalToolCalls += item.toolCalls
        }
      }
    }
    return {
      ...task,
      workflowProgress: progress,
      progressVersion: task.progressVersion + events.length,
      agentCount,
      totalTokens,
      totalToolCalls,
    }
  })
}

/**
 * Official 2.1.153 `AP8`.
 */
export function finalizeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  status: 'completed' | 'failed' | 'killed',
  extra: Partial<LocalWorkflowTaskState>,
): LocalWorkflowTaskState | null {
  let prior: LocalWorkflowTaskState | null = null
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }
    prior = task
    task.abortController?.abort()
    const endTime = Date.now()
    return {
      ...task,
      ...extra,
      status,
      endTime,
      ...(isTerminalTaskStatus(status)
        ? { evictAfter: endTime + PANEL_GRACE_MS }
        : {}),
      abortController: undefined,
      agentControllers: undefined,
    }
  })
  return prior
}

function finalizeViaRegistry(
  taskId: string,
  taskRegistry: WorkflowTaskRegistry,
  status: 'completed' | 'failed' | 'killed',
  extra: Partial<LocalWorkflowTaskState>,
): LocalWorkflowTaskState | null {
  let prior: LocalWorkflowTaskState | null = null
  taskRegistry.update(taskId, task => {
    if (task.status !== 'running') {
      return task
    }
    prior = task
    task.abortController?.abort()
    const endTime = Date.now()
    return {
      ...task,
      ...extra,
      status,
      endTime,
      ...(isTerminalTaskStatus(status)
        ? { evictAfter: endTime + PANEL_GRACE_MS }
        : {}),
      abortController: undefined,
      agentControllers: undefined,
    }
  })
  return prior
}

/**
 * Official 2.1.153 `am6`.
 */
export function completeLocalWorkflowTask(
  taskId: string,
  result: unknown,
  agentCount: number,
  logs: string[],
  taskRegistry: WorkflowTaskRegistry,
): void {
  const prior = finalizeViaRegistry(taskId, taskRegistry, 'completed', {
    result,
    agentCount,
    logs,
  })
  if (prior) {
    writeFile(
      prior.outputFile,
      jsonStringify(
        { summary: prior.summary, agentCount, logs, result },
        null,
        2,
      ),
    ).catch(error =>
      logForDebugging(
        `Failed to write workflow output for ${taskId}: ${error instanceof Error ? error.message : error}`,
      ),
    )
    logEvent('tengu_feature_ok', {
      feature_name:
        'task_local_workflow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
}

/**
 * Official 2.1.153 `YP8`.
 */
export function failLocalWorkflowTask(
  taskId: string,
  error: string,
  agentCount: number,
  logs: string[],
  taskRegistry: WorkflowTaskRegistry,
): void {
  const prior = finalizeViaRegistry(taskId, taskRegistry, 'failed', {
    error,
    agentCount,
    logs,
  })
  void evictTaskOutput(taskId)
  if (prior) {
    logEvent('tengu_feature_bad', {
      feature_name:
        'task_local_workflow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_code:
        'task_local_workflow_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
}

/**
 * Official 2.1.153 `OP8`.
 */
export function notifyLocalWorkflowTask({
  taskId,
  summary,
  status,
  result,
  failures,
  error,
  agentCount,
  totalTokens,
  totalToolCalls,
  durationMs,
  taskRegistry,
  toolUseId,
  transcriptDir,
  scriptPath,
  workflowRunId,
  args,
}: {
  taskId: string
  summary?: string
  status: string
  result?: unknown
  failures?: string[]
  error?: string
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  durationMs: number
  taskRegistry: WorkflowTaskRegistry
  toolUseId?: string
  transcriptDir?: string
  scriptPath?: string
  workflowRunId?: string
  args?: unknown
}): void {
  let shouldNotify = false
  taskRegistry.update(taskId, task => {
    if (task.notified) {
      return task
    }
    shouldNotify = true
    return { ...task, notified: true }
  })
  if (!shouldNotify) {
    return
  }
  taskRegistry.abortSpeculation()
  const name = summary ?? 'Dynamic workflow'
  const statusText =
    status === 'completed'
      ? `Dynamic workflow "${name}" completed`
      : status === 'failed'
        ? `Dynamic workflow "${name}" failed: ${error || 'Unknown error'}`
        : `Dynamic workflow "${name}" was stopped`
  let recovery = ''
  if (status === 'failed' || status === 'killed') {
    const lines: string[] = []
    if (scriptPath && workflowRunId) {
      const argsPart =
        args !== undefined ? `, args: ${jsonStringify(args)}` : ''
      lines.push(
        `To resume after editing the script, call: Workflow({scriptPath: '${scriptPath}', resumeFromRunId: '${workflowRunId}'${argsPart}})`,
      )
    }
    if (transcriptDir) {
      lines.push(`Agent transcripts: ${transcriptDir}`)
    }
    if (lines.length > 0) {
      recovery = `\n<recovery>${lines.join('\n')}</recovery>`
    }
  }
  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  let resultSection = ''
  if (status === 'completed' && result !== undefined) {
    const serialized = escapeXml(jsonStringify(result))
    if (serialized.length > 8000) {
      resultSection = `\n<result>${serialized.slice(0, 8000)}\n... (truncated ${serialized.length - 8000} chars, full result in ${outputPath})</result>`
    } else {
      resultSection = `\n<result>${serialized}</result>`
    }
  }
  const failuresSection = failures?.length
    ? `\n<failures>${escapeXml(failures.join('\n'))}</failures>`
    : ''
  const usage = `\n<usage><agent_count>${agentCount}</agent_count><total_tokens>${totalTokens}</total_tokens><tool_uses>${totalToolCalls}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(statusText)}</${SUMMARY_TAG}>${recovery}${resultSection}${failuresSection}${usage}
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
  })
}

/**
 * Official 2.1.153 `u_H`.
 */
export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): boolean {
  const prior = finalizeWorkflowTask(taskId, setAppState, 'killed', {
    notified: true,
  })
  if (prior) {
    void evictTaskOutput(taskId)
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId: prior.toolUseId,
      summary: prior.description,
    })
  }
  return prior !== null
}

/**
 * Official 2.1.153 `Wq4`.
 */
function abortWorkflowAgent(
  taskId: string,
  agentId: string,
  reason: string,
  setAppState: SetAppState,
): boolean {
  let aborted = false
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }
    const controller = task.agentControllers?.get(agentId)
    if (controller && !controller.signal.aborted) {
      controller.abort(reason)
      aborted = true
    }
    return task
  })
  if (aborted) {
    logEvent('tengu_feature_ok', {
      feature_name: (reason === 'user-skip'
        ? 'task_local_workflow_skip_agent'
        : 'task_local_workflow_retry_agent') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
  return aborted
}

/** Official 2.1.153 `V0$`. */
export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): boolean {
  return abortWorkflowAgent(taskId, agentId, 'user-skip', setAppState)
}

/** Official 2.1.153 `v0$`. */
export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): boolean {
  return abortWorkflowAgent(taskId, agentId, 'user-retry', setAppState)
}

/** Official 2.1.153 `PW_`. */
export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}
