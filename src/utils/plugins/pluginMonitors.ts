/**
 * Official 2.1.105 plugin background monitors (GkY / l_A / n_A / i_A / r_A / oM7 / Hq7).
 *
 * Manifest `monitors` (path or inline array) or default monitors/monitors.json.
 * Arms unsandboxed persistent Monitor tasks at session start (`when: "always"`)
 * or the first time a matching skill is invoked (`when: "on-skill-invoke:<skill>"`).
 */

import { feature } from 'bun:bundle'
import { readFile } from 'fs/promises'
import { join, relative, resolve } from 'path'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import type { TaskContext } from '../../Task.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import {
  PluginMonitorsArraySchema,
  type PluginMonitorDefinition,
} from './schemas.js'
import { logForDebugging } from '../debug.js'
import { isBareMode } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { shouldSkipHookDueToTrust } from '../hooks.js'
import { logError } from '../log.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { expandEnvVarsInString } from '../../services/mcp/envExpansion.js'
import { jsonParse } from '../slowOperations.js'
import { exec } from '../Shell.js'
import { escapeXml } from '../xml.js'
import {
  getPluginStorageId,
  loadPluginOptions,
  substitutePluginVariables,
  substituteUserConfigVariables,
} from './pluginOptionsStorage.js'

const RATE_LIMIT_TOKENS = 10
const RATE_LIMIT_REFILL_MS = 2_000
const MAX_LINE_CHARS = 500
const MAX_BATCH_CHARS = 3_000
const FLUSH_DEBOUNCE_MS = 200
const MAX_BUFFER_CHARS = 1_048_576

export type ResolvedPluginMonitor = {
  name: string
  command: string
  description: string
  when: string
  pluginName: string
  pluginRoot: string
}

const armedMonitorKeys = new Set<string>()

type SkillListener = (skillName: string) => void
const skillListeners = new Set<SkillListener>()

/** Official Hq7.emit — fire before skill-usage debounce so monitors still arm. */
export function notifySkillInvoked(skillName: string): void {
  for (const listener of skillListeners) {
    listener(skillName)
  }
}

/** Official Hq7.subscribe */
export function subscribeSkillInvoked(listener: SkillListener): () => void {
  skillListeners.add(listener)
  return () => {
    skillListeners.delete(listener)
  }
}

/**
 * Official B98: resolve a plugin-relative path and reject traversal.
 */
export function resolvePathWithinPlugin(
  pluginPath: string,
  relativePath: string,
): string | null {
  const resolvedPluginPath = resolve(pluginPath)
  const resolvedFilePath = resolve(pluginPath, relativePath)
  const rel = relative(resolvedPluginPath, resolvedFilePath)
  if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) {
    return null
  }
  return resolvedFilePath
}

function enqueuePluginMonitorEvent(
  description: string,
  event: string,
  taskId?: string,
): void {
  const taskIdLine = taskId
    ? `\n<${TASK_ID_TAG}>${escapeXml(taskId)}</${TASK_ID_TAG}>`
    : ''
  enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>${taskIdLine}
<${SUMMARY_TAG}>Monitor event: "${escapeXml(description)}"</${SUMMARY_TAG}>
<event>${escapeXml(event)}</event>
</${TASK_NOTIFICATION_TAG}>`,
    mode: 'task-notification',
    priority: 'next',
  })
}

function createTokenBucket(
  maxTokens: number,
  refillIntervalMs: number,
): { tryConsume: () => boolean } {
  let tokens = maxTokens
  let last = Date.now()
  return {
    tryConsume() {
      const now = Date.now()
      const steps = Math.floor((now - last) / refillIntervalMs)
      if (steps > 0) {
        tokens = Math.min(maxTokens, tokens + steps)
        last += steps * refillIntervalMs
      }
      if (tokens > 0) {
        tokens--
        return true
      }
      return false
    },
  }
}

function createLineBuffer(onFlush: (batch: string) => void): {
  onData: (chunk: string) => void
  flush: (force?: boolean) => void
} {
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
      const timer = setTimeout(() => flush(), FLUSH_DEBOUNCE_MS)
      cancel = () => clearTimeout(timer)
    }
  }

  return { onData, flush }
}

/** Official GkY */
export async function loadPluginMonitors(
  pluginPath: string,
  manifest: LoadedPlugin['manifest'],
  source: string,
  errors: PluginError[],
): Promise<PluginMonitorDefinition[] | undefined> {
  // Official 2.1.129: `experimental.monitors` is the supported spelling; the
  // top-level field still loads.
  const monitors = manifest.experimental?.monitors ?? manifest.monitors

  let filePath: string | undefined
  if (monitors === undefined) {
    const defaultPath = join(pluginPath, 'monitors', 'monitors.json')
    if (await pathExists(defaultPath)) {
      filePath = defaultPath
    }
  } else if (typeof monitors === 'string') {
    const validated = resolvePathWithinPlugin(pluginPath, monitors)
    if (validated === null) {
      errors.push({
        type: 'path-traversal',
        source,
        plugin: manifest.name,
        path: monitors,
        component: 'monitors',
      })
      return
    }
    filePath = validated
  } else {
    return monitors
  }

  if (filePath === undefined) {
    return
  }

  try {
    const content = await readFile(filePath, { encoding: 'utf-8' })
    return PluginMonitorsArraySchema().parse(jsonParse(content))
  } catch (error) {
    const reason = errorMessage(error)
    logForDebugging(
      `Failed to load monitors for ${manifest.name} from ${filePath}: ${reason}`,
      { level: 'error' },
    )
    errors.push({
      type: 'component-load-failed',
      source,
      plugin: manifest.name,
      component: 'monitors',
      path: filePath,
      reason,
    })
  }
}

/** Official l_A */
export function resolvePluginMonitor(
  definition: PluginMonitorDefinition,
  plugin: LoadedPlugin,
): ResolvedPluginMonitor {
  const userConfig = plugin.manifest.userConfig
    ? loadPluginOptions(getPluginStorageId(plugin))
    : undefined
  const expand = (value: string): string => {
    let out = substitutePluginVariables(value, plugin)
    if (userConfig) {
      out = substituteUserConfigVariables(out, userConfig)
    }
    return expandEnvVarsInString(out).expanded
  }
  return {
    name: definition.name,
    command: expand(definition.command),
    description: definition.description,
    when: definition.when,
    pluginName: plugin.name,
    pluginRoot: plugin.path,
  }
}

function collectResolvedMonitors(
  plugins: LoadedPlugin[],
): ResolvedPluginMonitor[] {
  const resolved: ResolvedPluginMonitor[] = []
  for (const plugin of plugins) {
    if (!plugin.monitors) {
      continue
    }
    for (const definition of plugin.monitors) {
      try {
        resolved.push(resolvePluginMonitor(definition, plugin))
      } catch (error) {
        logForDebugging(
          `plugin ${plugin.name}: failed to resolve monitor "${definition.name}": ${error}`,
          { level: 'error' },
        )
      }
    }
  }
  return resolved
}

/** Official r_A */
async function armResolvedMonitor(
  monitor: ResolvedPluginMonitor,
  context: TaskContext,
): Promise<string | undefined> {
  if (getIsRemoteMode()) {
    return
  }
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping plugin monitor ${monitor.pluginName}:${monitor.name} - workspace trust not accepted`,
    )
    return
  }

  const taskRef: { id?: string } = {}
  const bucket = createTokenBucket(RATE_LIMIT_TOKENS, RATE_LIMIT_REFILL_MS)
  let suppressed = 0
  function flushSuppressed(): void {
    if (suppressed === 0) {
      return
    }
    enqueuePluginMonitorEvent(
      monitor.description,
      `[plugin monitor "${monitor.name}" suppressed ${suppressed} events — output rate exceeded]`,
      taskRef.id,
    )
    suppressed = 0
  }

  const lineBuffer = createLineBuffer(batch => {
    if (!bucket.tryConsume()) {
      suppressed++
      return
    }
    flushSuppressed()
    enqueuePluginMonitorEvent(monitor.description, batch, taskRef.id)
  })

  const shellCommand = await exec(
    monitor.command,
    context.abortController.signal,
    'bash',
    {
      preventCwdChanges: true,
      shouldUseSandbox: false,
      onStdout: lineBuffer.onData,
    },
  )
  taskRef.id = shellCommand.taskOutput.taskId
  await spawnShellTask(
    {
      command: monitor.command,
      description: monitor.description,
      shellCommand,
      toolUseId: undefined,
      agentId: undefined,
      kind: 'monitor',
    },
    context,
  )
  void shellCommand.result.then(() => {
    lineBuffer.flush(true)
    flushSuppressed()
  })
  return taskRef.id
}

/** Official oM7 */
export async function armPluginMonitors(
  plugins: LoadedPlugin[],
  shouldArm: (monitor: ResolvedPluginMonitor) => boolean,
  context: TaskContext,
): Promise<void> {
  if (!feature('MONITOR_TOOL')) {
    return
  }
  if (isBareMode()) {
    return
  }
  for (const monitor of collectResolvedMonitors(plugins)) {
    if (!shouldArm(monitor)) {
      continue
    }
    const key = `${monitor.pluginName}:${monitor.name}`
    if (armedMonitorKeys.has(key)) {
      continue
    }
    armedMonitorKeys.add(key)
    try {
      if ((await armResolvedMonitor(monitor, context)) === undefined) {
        armedMonitorKeys.delete(key)
      }
    } catch (error) {
      armedMonitorKeys.delete(key)
      logError(error)
      logForDebugging(`plugin monitor ${key}: failed to arm: ${error}`, {
        level: 'error',
      })
    }
  }
}
