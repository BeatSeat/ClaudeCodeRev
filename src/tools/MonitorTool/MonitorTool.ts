import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { isBashShellAvailable } from '../../utils/shell/shellToolUtils.js'
import { exec } from '../../utils/Shell.js'
import { escapeXml } from '../../utils/xml.js'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'
import type { BashToolInput } from '../BashTool/BashTool.js'
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'
import {
  DEFAULT_TIMEOUT_MS,
  DESCRIPTION,
  MAX_TIMEOUT_MS,
  MONITOR_TOOL_NAME,
} from './prompt.js'
import {
  getPushNotificationEventHint,
  getPushNotificationPromptSection,
  isPushWhenClaudeDecidesEnabled,
} from '../PushNotificationTool/prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const RATE_LIMIT_TOKENS = 10
const RATE_LIMIT_REFILL_MS = 2_000
const RATE_LIMIT_STOP_MS = 30_000
const MAX_LINE_CHARS = 500
const MAX_BATCH_CHARS = 3_000
const FLUSH_DEBOUNCE_MS = 200
const MAX_BUFFER_CHARS = 1_048_576

const COMMAND_DESCRIPTION =
  'Shell command or script. Each stdout line is an event; exit ends the watch.'

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      description: z
        .string()
        .describe(
          'Short human-readable description of what you are monitoring (shown in notifications).',
        ),
      timeout_ms: z
        .number()
        .min(1000)
        .optional()
        .default(DEFAULT_TIMEOUT_MS)
        .describe(
          `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true.`,
        ),
      persistent: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop.',
        ),
      command: z.string().describe(COMMAND_DESCRIPTION),
    })
    .refine(input => input.persistent || input.timeout_ms <= MAX_TIMEOUT_MS, {
      message: `timeout_ms must be ≤ ${MAX_TIMEOUT_MS}`,
      path: ['timeout_ms'],
    }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type MonitorToolInput = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string().describe('ID of the background monitor task.'),
    timeoutMs: z
      .number()
      .describe('Timeout deadline in milliseconds (0 when persistent).'),
    persistent: z
      .boolean()
      .optional()
      .describe('No timeout — runs until TaskStop or session end.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function enqueueMonitorEvent(
  description: string,
  event: string,
  taskId?: string,
  opts?: { housekeeping?: boolean },
): void {
  const taskIdLine = taskId
    ? `\n<${TASK_ID_TAG}>${escapeXml(taskId)}</${TASK_ID_TAG}>`
    : ''
  const pushHint =
    !opts?.housekeeping && isPushWhenClaudeDecidesEnabled()
      ? `\n${getPushNotificationEventHint()}`
      : ''
  const message = `<${TASK_NOTIFICATION_TAG}>${taskIdLine}
<${SUMMARY_TAG}>Monitor event: "${escapeXml(description)}"</${SUMMARY_TAG}>
<event>${escapeXml(event)}</event>${pushHint}
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
  })
}

function createTokenBucket(
  maxTokens: number,
  refillIntervalMs: number,
  now: () => number = Date.now,
): { tryConsume: () => boolean } {
  let tokens = maxTokens
  let last = now()
  function refill(): void {
    const t = now()
    const steps = Math.floor((t - last) / refillIntervalMs)
    if (steps > 0) {
      tokens = Math.min(maxTokens, tokens + steps)
      last += steps * refillIntervalMs
    }
  }
  return {
    tryConsume() {
      refill()
      if (tokens > 0) {
        tokens--
        return true
      }
      return false
    },
  }
}

function createLineBuffer(
  onFlush: (batch: string) => void,
  schedule: (fn: () => void) => () => void = fn => {
    const timer = setTimeout(fn, FLUSH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  },
): { onData: (chunk: string) => void; flush: (force?: boolean) => void } {
  let buf = ''
  let lines: string[] = []
  let cancel: (() => void) | null = null

  function flush(force?: boolean): void {
    if (cancel) {
      cancel()
      cancel = null
    }
    if (force && buf.trim()) {
      let line = buf.trim()
      if (line.length > MAX_LINE_CHARS) {
        line = line.slice(0, MAX_LINE_CHARS) + '...(truncated)'
      }
      lines.push(line)
      buf = ''
    }
    if (lines.length === 0) {
      return
    }
    let joined = lines.join('\n')
    if (joined.length > MAX_BATCH_CHARS) {
      joined = joined.slice(0, MAX_BATCH_CHARS) + '\n...(truncated)'
    }
    lines = []
    onFlush(joined)
  }

  function onData(chunk: string): void {
    buf += chunk
    if (buf.length > MAX_BUFFER_CHARS) {
      buf = buf.slice(-MAX_BUFFER_CHARS)
    }
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) {
        if (line.length > MAX_LINE_CHARS) {
          line = line.slice(0, MAX_LINE_CHARS) + '...(truncated)'
        }
        lines.push(line)
      }
    }
    if (lines.length > 0 && !cancel) {
      cancel = schedule(() => flush())
    }
  }

  return { onData, flush }
}

async function startMonitor(
  command: string,
  input: MonitorToolInput,
  context: ToolUseContext,
): Promise<{ data: Output }> {
  const { description, timeout_ms, persistent } = input
  const { abortController, toolUseId, agentId } = context
  const setAppState = context.setAppStateForTasks ?? context.setAppState

  const taskRef: { id?: string } = {}
  let stopped = false
  let suppressed = 0
  let lastSuppressAt: number | undefined
  let overRateSince: number | undefined
  const bucket = createTokenBucket(RATE_LIMIT_TOKENS, RATE_LIMIT_REFILL_MS)

  const lineBuffer = createLineBuffer(batch => {
    if (stopped) {
      return
    }
    if (bucket.tryConsume()) {
      if (suppressed > 0) {
        enqueueMonitorEvent(
          description,
          `[${suppressed} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
          taskRef.id,
          { housekeeping: true },
        )
        suppressed = 0
        if (
          lastSuppressAt !== undefined &&
          Date.now() - lastSuppressAt > RATE_LIMIT_REFILL_MS * 3
        ) {
          overRateSince = undefined
        }
      }
      enqueueMonitorEvent(description, batch, taskRef.id)
      return
    }
    suppressed++
    lastSuppressAt = Date.now()
    if (overRateSince === undefined) {
      overRateSince = Date.now()
    }
    if (Date.now() - overRateSince > RATE_LIMIT_STOP_MS) {
      stopped = true
      enqueueMonitorEvent(
        description,
        `[Monitor stopped — your script produced too much output (${suppressed} events suppressed over ${Math.round((Date.now() - overRateSince) / 1000)}s). Write a new monitor command that filters more aggressively — pipe through grep --line-buffered, awk, or a wrapper script that only emits the specific events you need.]`,
        taskRef.id,
        { housekeeping: true },
      )
      if (taskRef.id) {
        emitTaskTerminatedSdk(taskRef.id, 'stopped', {
          toolUseId,
          summary: description,
        })
        killTask(taskRef.id, setAppState)
      }
    }
  })

  const shellCommand = await exec(command, abortController.signal, 'bash', {
    preventCwdChanges: true,
    shouldUseSandbox: shouldUseSandbox({ command }),
    onStdout: lineBuffer.onData,
    sessionEnvVars: context.sessionEnvVars,
  })

  const handle = await spawnShellTask(
    {
      command,
      description,
      shellCommand,
      toolUseId,
      agentId,
      kind: 'monitor',
    },
    {
      abortController,
      getAppState: context.getAppState,
      setAppState,
    },
  )
  taskRef.id = handle.taskId

  const timeoutHandle = persistent
    ? undefined
    : setTimeout(() => {
        if (stopped) {
          return
        }
        enqueueMonitorEvent(
          description,
          '[Monitor timed out — re-arm if needed.]',
          handle.taskId,
          { housekeeping: true },
        )
        emitTaskTerminatedSdk(handle.taskId, 'stopped', {
          toolUseId,
          summary: description,
        })
        killTask(handle.taskId, setAppState)
      }, timeout_ms)

  void shellCommand.result.then(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
    lineBuffer.flush(true)
    stopped = true
  })

  return {
    data: {
      taskId: handle.taskId,
      timeoutMs: persistent ? 0 : timeout_ms,
      persistent,
    },
  }
}

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'stream events from a background script as live notifications',
  maxResultSizeChars: 10_000,
  shouldDefer: true,
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    return input?.description
      ? `Monitoring: ${input.description}`
      : 'Monitoring'
  },
  isEnabled() {
    // Official 2.1.120: Monitor shells out via bash; hide when Git Bash is gone.
    return (
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_sentinel', false) &&
      isBashShellAvailable()
    )
  },
  isConcurrencySafe() {
    return true
  },
  renderToolUseMessage,
  renderToolResultMessage,
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Monitor started (task ${output.taskId}, ${output.persistent ? 'persistent — runs until TaskStop or session end' : `timeout ${output.timeoutMs}ms`}). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
    }
  },
  async description() {
    return isPushWhenClaudeDecidesEnabled()
      ? DESCRIPTION + getPushNotificationPromptSection()
      : DESCRIPTION
  },
  async prompt() {
    return isPushWhenClaudeDecidesEnabled()
      ? DESCRIPTION + getPushNotificationPromptSection()
      : DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    return bashToolHasPermission(
      { command: input.command } as BashToolInput,
      context,
    )
  },
  async call(input, context) {
    return startMonitor(input.command, input, context)
  },
} satisfies ToolDef<InputSchema, Output>)
