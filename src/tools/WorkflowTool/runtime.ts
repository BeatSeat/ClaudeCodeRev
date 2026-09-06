import { createHash } from 'crypto'
import { mkdir, readdir, readFile, appendFile, writeFile } from 'fs/promises'
import { cpus } from 'os'
import { dirname, join } from 'path'
import vm from 'vm'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool, ToolUseContext, Tools } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  getAgentContext,
  runWithAgentContext,
} from '../../utils/agentContext.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import {
  isBuiltInAgent,
  type AgentDefinition,
} from '../AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { createSyntheticOutputTool } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowProgressEvent } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { AssistantMessage } from '../../types/message.js'
import { getCwd, runWithCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isENOENT } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getBranch, gitExe } from '../../utils/git.js'
import { addFunctionHook, clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { logError } from '../../utils/log.js'
import { createUserMessage, extractTextContent, hasSuccessfulToolCall } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../../utils/permissions/permissions.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { sleep } from '../../utils/sleep.js'
import { plural } from '../../utils/stringUtils.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { createAgentId } from '../../utils/uuid.js'
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from '../../utils/worktree.js'
import {
  compileWorkflowScript,
  findWorkflowByName,
  listWorkflows,
  parseWorkflowScript,
  readWorkflowScriptPath,
} from './WorkflowTool.js'

/** Official 2.1.153 `EGH`. */
const WORKFLOW_CHILD_MARK = '\u25B8'
/** Official 2.1.153 `wP8`. */
const WORKFLOW_SYNC_TIMEOUT_MS = 30_000
/** Official 2.1.153 `d2_`. */
const WORKFLOW_LOG_CAP = 1000
/** Official 2.1.153 `Q2_`. */
const WORKFLOW_STALL_MS = 180_000
/** Official 2.1.153 `EK4`. */
const WORKFLOW_STALL_RETRIES = 5
/** Official 2.1.153 `hK4`. */
const WORKFLOW_AGENT_CAP = 1000
/** Official 2.1.153 `NK4`. */
const WORKFLOW_PREVIEW_CHARS = 400
/** Official 2.1.153 `R2_`. */
const JOURNAL_KEY_VERSION = 'v2'
/** Official 2.1.153 `bZ_`. */
export const WORKFLOW_BUILTIN_DESC_CAP = 200

const DATE_NOW_ERR =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.'
const MATH_RANDOM_ERR =
  'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.'

/** Official 2.1.153 `GW_`. */
const WORKFLOW_VM_SHIMS = `(() => {
      const NOW_ERR = ${jsonStringify(DATE_NOW_ERR)};
      const RANDOM_ERR = ${jsonStringify(MATH_RANDOM_ERR)};
      Math.random = function random() { throw new Error(RANDOM_ERR) };
      const RealDate = Date;
      RealDate.now = function now() { throw new Error(NOW_ERR) };
      function ShimDate(...a) {
        if (!new.target) throw new Error(NOW_ERR);
        if (a.length === 0) throw new Error(NOW_ERR);
        return Reflect.construct(RealDate, a, new.target);
      }
      ShimDate.now = RealDate.now;
      ShimDate.parse = RealDate.parse;
      ShimDate.UTC = RealDate.UTC;
      ShimDate.prototype = RealDate.prototype;
      RealDate.prototype.constructor = ShimDate;
      Object.freeze(RealDate);
      globalThis.Date = ShimDate;
    })()`

/** Official 2.1.153 `StH` body. */
const WORKFLOW_VM_FREEZE = `(() => {
    Object.defineProperty(Error, 'prepareStackTrace', {
      value: (err, sites) => String(err.stack ?? err),
      writable: false, configurable: false,
    });
    delete globalThis.ShadowRealm;
    delete globalThis.WebAssembly;
    function enableOverride(proto, key) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || 'get' in d) return;
      const v = d.value;
      Object.defineProperty(proto, key, {
        get() { return v },
        set(nv) {
          if (this === proto) return;
          Object.defineProperty(this, key, { value: nv, writable: true, enumerable: true, configurable: true });
        },
        enumerable: d.enumerable, configurable: true,
      });
    }
    const errorProtos = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError].map(C => C.prototype);
    for (const [proto, keys] of [
      [Object.prototype, Object.getOwnPropertyNames(Object.prototype)],
      [Function.prototype, ['toString', 'constructor', 'name', 'length']],
      [Array.prototype, ['toString', 'constructor']],
      [Date.prototype, ['toString', 'toLocaleString', 'valueOf', 'constructor']],
      ...errorProtos.map(p => [p, ['name', 'message', 'toString', 'constructor']]),
    ]) for (const k of keys) enableOverride(proto, k);
    for (const C of [
      Promise, Object, Array, Function, Error,
      EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError,
      Date, Map, Set, WeakMap, WeakSet, RegExp,
      ArrayBuffer, SharedArrayBuffer, DataView, Object.getPrototypeOf(Int8Array),
      Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
      typeof URL !== 'undefined' ? URL : undefined,
      typeof Iterator !== 'undefined' ? Iterator : undefined,
    ]) {
      if (C === undefined) continue;
      Object.freeze(C);
      Object.freeze(C.prototype);
    }
    for (const it of [
      [][Symbol.iterator](),
      ''[Symbol.iterator](),
      new Map()[Symbol.iterator](),
      new Set()[Symbol.iterator](),
      (function*(){})(),
      (async function*(){})(),
    ]) {
      for (let p = Object.getPrototypeOf(it); p; p = Object.getPrototypeOf(p)) {
        Object.freeze(p);
      }
    }
    })()`

const WORKFLOW_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`

const WORKFLOW_CUSTOM_AGENT_NOTE = `

---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`

const WORKFLOW_SCHEMA_NOTE = `

---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${SYNTHETIC_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${SYNTHETIC_OUTPUT_TOOL_NAME} again with a corrected shape.`

const WORKFLOW_SCHEMA_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${SYNTHETIC_OUTPUT_TOOL_NAME} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool call.
- If the schema validation fails, read the error and call ${SYNTHETIC_OUTPUT_TOOL_NAME} again with a corrected shape.
- After calling ${SYNTHETIC_OUTPUT_TOOL_NAME} successfully, end your turn. No acknowledgment needed.`

const AGENT_CAP_MESSAGE = `Workflow agent() call cap reached (${WORKFLOW_AGENT_CAP}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`

class WorkflowAgentCapError extends Error {
  constructor() {
    super(AGENT_CAP_MESSAGE)
    this.name = 'WorkflowAgentCapError'
  }
}

class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${budget.toLocaleString()} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
    )
    this.name = 'WorkflowBudgetExceededError'
  }
}

/** Official 2.1.153 `NE`. */
function sealFn<T extends Function>(fn: T): T {
  Object.setPrototypeOf(fn, null)
  delete (fn as { constructor?: unknown }).constructor
  delete (fn as { prototype?: unknown }).prototype
  return fn
}

/** Official 2.1.153 `zZH`. */
function formatWorkflowError(error: unknown, maxFrames = 5): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (!error.stack) {
    return error.message
  }
  const lines = error.stack.split('\n')
  const head = lines[0] ?? error.message
  const frames = lines.slice(1).filter(line => line.trim().startsWith('at '))
  if (frames.length <= maxFrames) {
    return error.stack
  }
  return [head, ...frames.slice(0, maxFrames)].join('\n')
}

/** Official 2.1.153 `ahH`. */
function previewValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined
  }
  const text = (typeof value === 'string' ? value : jsonStringify(value)).trim()
  if (!text) {
    return undefined
  }
  return text.length > WORKFLOW_PREVIEW_CHARS
    ? text.slice(0, WORKFLOW_PREVIEW_CHARS) + '\u2026'
    : text
}

/** Official 2.1.153 `pP8`. */
function toolInputSummary(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string') {
      const trimmed = value.replace(/\s+/g, ' ').trim()
      return trimmed.length > 60 ? trimmed.slice(0, 60) : trimmed
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string') {
      const trimmed = value.replace(/\s+/g, ' ').trim()
      return trimmed.length > 60 ? trimmed.slice(0, 60) : trimmed
    }
  }
  return ''
}

/** Official 2.1.153 `I2_`. */
function canonicalizeAgentOpts(opts: AgentHookOpts | undefined): string {
  if (!opts) {
    return '{}'
  }
  const picked: Record<string, unknown> = {}
  for (const key of ['schema', 'model', 'effort', 'isolation', 'agentType'] as const) {
    const value = opts[key]
    if (value === undefined || typeof value === 'function') {
      continue
    }
    picked[key] = value
  }
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sort)
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key])
      }
      return out
    }
    return value
  }
  return jsonStringify(sort(picked))
}

/** Official 2.1.153 `kK4`. */
function journalKey(prompt: string, opts: AgentHookOpts | undefined, chain: string): string {
  const digest = createHash('sha256')
    .update(chain)
    .update('\0')
    .update(prompt)
    .update('\0')
    .update(canonicalizeAgentOpts(opts))
    .digest('hex')
  return `${JOURNAL_KEY_VERSION}:${digest}`
}

/** Official 2.1.153 `C2_`. */
function workflowConcurrency(cpuCount: number): number {
  return Math.min(16, Math.max(2, cpuCount - 2))
}

/** Official 2.1.153 `IiH`. */
function createSemaphore<Args extends unknown[], R>(
  limit: number,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++
      return Promise.resolve()
    }
    return new Promise(resolve => waiters.push(resolve))
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next) {
      next()
    } else {
      active--
    }
  }
  return async (...args: Args) => {
    await acquire()
    try {
      return await fn(...args)
    } finally {
      release()
    }
  }
}

/** Official 2.1.153 `em6`. */
function createWorkflowConsole(write: (message: string) => void): {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
} {
  const format = (args: unknown[]) =>
    args
      .map(arg => {
        if (typeof arg === 'string') {
          return arg
        }
        try {
          return jsonStringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(' ')
  const prefixed = (prefix: string) =>
    (...args: unknown[]) => write(prefix + format(args))
  return {
    log: prefixed(''),
    info: prefixed(''),
    debug: prefixed(''),
    error: prefixed('[error] '),
    warn: prefixed('[warn] '),
  }
}

/** Official 2.1.153 `Zq4`. */
function createAbortTimers(signal: AbortSignal | undefined): {
  setTimeout: (fn: () => void, ms?: number) => number
  clearTimeout: (id: number) => void
} {
  const ids = new Set<number>()
  signal?.addEventListener(
    'abort',
    () => {
      for (const id of ids) {
        clearTimeout(id)
      }
      ids.clear()
    },
    { once: true },
  )
  return {
    setTimeout: sealFn((fn: () => void, ms?: number) => {
      if (signal?.aborted) {
        return 0
      }
      const id = Number(setTimeout(fn, ms))
      ids.add(id)
      return id
    }),
    clearTimeout: sealFn((id: number) => {
      ids.delete(id)
      clearTimeout(id)
    }),
  }
}

/** Official 2.1.153 `jP8`. */
function installWorkflowShims(context: vm.Context): void {
  vm.runInContext(WORKFLOW_VM_SHIMS, context)
}

/** Official 2.1.153 `StH`. */
function freezeWorkflowContext(context: vm.Context): void {
  vm.runInContext(WORKFLOW_VM_FREEZE, context)
}

/** Official 2.1.153 `Gq4`. */
function createVmAwait(context: vm.Context): (value: unknown) => Promise<unknown> {
  return vm.runInContext('(async v => v)', context) as (value: unknown) => Promise<unknown>
}

type JournalEntry =
  | { type: 'result'; key: string; agentId: string; result: unknown }
  | { type: 'started'; key: string; agentId: string }

type JournalState = {
  results: Map<string, JournalEntry & { type: 'result' }>
  started: Map<string, Array<JournalEntry & { type: 'started' }>>
}

/** Official 2.1.153 `VK4`. */
function indexJournal(entries: JournalEntry[]): JournalState {
  const results = new Map<string, JournalEntry & { type: 'result' }>()
  const started = new Map<string, Array<JournalEntry & { type: 'started' }>>()
  for (const entry of entries) {
    if (entry.type === 'result') {
      results.set(entry.key, entry)
    } else if (entry.type === 'started') {
      const list = started.get(entry.key)
      if (list) {
        list.push(entry)
      } else {
        started.set(entry.key, [entry])
      }
    }
  }
  return { results, started }
}

/** Official 2.1.153 `QtH`. */
export function getWorkflowTranscriptDir(runId: string): string {
  const root = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(root, getSessionId(), 'subagents', 'workflows', runId)
}

/** Official 2.1.153 `ZK4`. */
export function getWorkflowSnapshotDir(): string {
  const root = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(root, getSessionId(), 'workflows')
}

/** Official 2.1.153 `S2_`. */
function getWorkflowSnapshotPath(runId: string): string {
  return join(getWorkflowSnapshotDir(), `${runId}.json`)
}

/** Official 2.1.153 `u9H` / `l88` / `f75` / `RUK`. */
export function persistWorkflowScript(
  name: string,
  runId: string,
  script: string,
): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
  const dir = join(getProjectDir(getCwd()), getSessionId(), 'workflows', 'scripts')
  const path = `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : '/'}${slug}-${runId}.js`
  void (async () => {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(path, script, { encoding: 'utf-8', mode: 0o600 })
    } catch (error) {
      logForDebugging(
        `Failed to persist workflow script to ${path}: ${error}`,
        { level: 'warn' },
      )
    }
  })()
  return path
}

/** Official 2.1.153 `GK4`. */
export async function persistWorkflowSnapshot(
  runId: string,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    const payload = { runId, timestamp: new Date().toISOString(), ...record }
    const path = getWorkflowSnapshotPath(runId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, jsonStringify(payload), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    logForDebugging(
      `Failed to write workflow snapshot ${runId}: ${error instanceof Error ? error.message : error}`,
    )
  }
}

/** Official 2.1.153 `TK4` snapshot row. */
export type WorkflowSnapshot = {
  runId: string
  taskId: string
  timestamp: string
  script: string
  scriptPath?: string
  args?: unknown
  result?: unknown
  agentCount: number
  logs: string[]
  durationMs: number
  error?: string
  summary?: string
  workflowName?: string
  title?: string
  status: string
  startTime: number
  phases?: Array<{ title: string; detail?: string; model?: string }>
  defaultModel?: string
  workflowProgress: WorkflowProgressEvent[]
  totalTokens: number
  totalToolCalls: number
}

/** Official 2.1.153 `TK4`. */
export async function loadWorkflowHistory(): Promise<WorkflowSnapshot[]> {
  const dir = getWorkflowSnapshotDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const rows = (
    await Promise.all(
      names
        .filter(name => name.endsWith('.json'))
        .map(async (name): Promise<WorkflowSnapshot | null> => {
          try {
            const raw = await readFile(join(dir, name), 'utf8')
            const parsed = JSON.parse(raw) as Record<string, unknown>
            const runId =
              (typeof parsed.runId === 'string' && parsed.runId) ||
              name.replace(/\.json$/, '')
            const timestamp =
              typeof parsed.timestamp === 'string'
                ? parsed.timestamp
                : new Date(0).toISOString()
            const error =
              typeof parsed.error === 'string' ? parsed.error : undefined
            return {
              runId,
              taskId:
                typeof parsed.taskId === 'string' ? parsed.taskId : runId,
              timestamp,
              script: typeof parsed.script === 'string' ? parsed.script : '',
              scriptPath:
                typeof parsed.scriptPath === 'string'
                  ? parsed.scriptPath
                  : undefined,
              args: parsed.args,
              result: parsed.result,
              agentCount:
                typeof parsed.agentCount === 'number' ? parsed.agentCount : 0,
              logs: Array.isArray(parsed.logs)
                ? parsed.logs.filter(
                    (line): line is string => typeof line === 'string',
                  )
                : [],
              durationMs:
                typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
              error,
              summary:
                typeof parsed.summary === 'string' ? parsed.summary : undefined,
              workflowName:
                typeof parsed.workflowName === 'string'
                  ? parsed.workflowName
                  : undefined,
              title: typeof parsed.title === 'string' ? parsed.title : undefined,
              status:
                typeof parsed.status === 'string'
                  ? parsed.status
                  : error
                    ? 'failed'
                    : 'completed',
              startTime:
                typeof parsed.startTime === 'number'
                  ? parsed.startTime
                  : Date.parse(timestamp) || 0,
              phases: parsed.phases as WorkflowSnapshot['phases'],
              defaultModel:
                typeof parsed.defaultModel === 'string'
                  ? parsed.defaultModel
                  : undefined,
              workflowProgress: Array.isArray(parsed.workflowProgress)
                ? (parsed.workflowProgress as WorkflowProgressEvent[])
                : [],
              totalTokens:
                typeof parsed.totalTokens === 'number'
                  ? parsed.totalTokens
                  : 0,
              totalToolCalls:
                typeof parsed.totalToolCalls === 'number'
                  ? parsed.totalToolCalls
                  : 0,
            }
          } catch (error) {
            logForDebugging(
              `Failed to parse workflow snapshot ${name}: ${error instanceof Error ? error.message : error}`,
            )
            return null
          }
        }),
    )
  ).filter((row): row is WorkflowSnapshot => row !== null)
  rows.sort((a, b) => b.startTime - a.startTime)
  return rows
}

/** Official 2.1.153 `CZ_`. */
export function telemetryWorkflowName(
  name: string | undefined,
  source: string | undefined,
): string {
  if (source === 'built-in' && name) {
    return name
  }
  return 'custom'
}

/** Official 2.1.153 `xZ_`. */
export function telemetryWorkflowDescription(
  description: string | undefined,
  source: string | undefined,
): string {
  if (source === 'built-in') {
    return (description ?? '').slice(0, WORKFLOW_BUILTIN_DESC_CAP)
  }
  return ''
}

/** Official 2.1.153 `CB6`. */
export class LocalFileJournal {
  path: string
  dirReady = false
  constructor(runId: string) {
    this.path = join(getWorkflowTranscriptDir(runId), 'journal.jsonl')
  }
  async load(): Promise<JournalState> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isENOENT(error)) {
        return indexJournal([])
      }
      throw error
    }
    const entries: JournalEntry[] = []
    for (const line of text.split('\n')) {
      if (!line) {
        continue
      }
      try {
        entries.push(JSON.parse(line) as JournalEntry)
      } catch (error) {
        logForDebugging(
          `LocalFileJournal: skipping unparseable line in ${this.path}: ${error}`,
        )
      }
    }
    return indexJournal(entries)
  }
  async append(entry: JournalEntry): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true })
      this.dirReady = true
    }
    await appendFile(this.path, `${jsonStringify(entry)}\n`, 'utf8')
  }
}

export type AgentHookOpts = {
  label?: unknown
  phase?: unknown
  schema?: unknown
  model?: unknown
  effort?: unknown
  isolation?: unknown
  agentType?: unknown
  stallMs?: unknown
}

export type WorkflowProgressMessage = {
  type: 'progress'
  toolUseID: string
  data: WorkflowProgressEvent
}

type TokenBudget = {
  total: number | null
  getTurnSpent: () => number
}

type WorkflowHooks = {
  agent: (prompt: unknown, opts?: AgentHookOpts) => Promise<unknown>
  parallel: (thunks: unknown) => Promise<unknown[]>
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>
  log: (message: unknown) => void
  phase: (title: unknown) => void
  resolvePhase: (title: string, kind?: string) => number
  recordFailure: (message: string) => void
  getAgentCount: () => number
  getFailures: () => string[]
  bindVMAwait: (fn: (value: unknown) => Promise<unknown>) => void
}

type AgentRunResult = {
  structured: unknown
  text: string
  tokens: number
  toolCalls: number
  stalled: boolean
  stalledReason?: string
  skipped: boolean
  durationMs: number
  stopReason: string | null | undefined
  outputTokens: number | undefined
  structuredOutputAttempts: number
  lastStructuredOutputInput: unknown
}

function isMcpTool(tool: Tool): boolean {
  return tool.name?.startsWith('mcp__') || tool.isMcp === true
}

async function isBranchOnOrigin(branch: string, cwd: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    { cwd, preserveOutputOnError: false },
  )
  return result.code === 0
}

function defaultWorkflowAgent(schema: boolean): AgentDefinition {
  return {
    agentType: 'workflow-subagent',
    whenToUse: 'Internal subagent for workflow script orchestration.',
    tools: ['*'],
    disallowedTools: ['SendUserMessage', AGENT_TOOL_NAME],
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () =>
      schema ? WORKFLOW_SCHEMA_SUBAGENT_PROMPT : WORKFLOW_SUBAGENT_PROMPT,
  }
}

/** Official 2.1.153 `RK4`. */
function createWorkflowHooks(
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  onProgress: (message: WorkflowProgressMessage) => void,
  workflowRunId: string | undefined,
  onAgentController: ((agentId: string, controller: AbortController | null) => void) | undefined,
  seedPhaseTitles: string[] | undefined,
  tokenBudget: TokenBudget | undefined,
  journal: LocalFileJournal | undefined,
  journalState: JournalState | undefined,
): WorkflowHooks {
  let agentCount = 0
  let vmAwait: (value: unknown) => Promise<unknown> = async value => value
  let currentPhase = ''
  let journalChain = ''
  let pastCachePrefix = false
  let agentCapLogged = false
  let budgetCapLogged = false
  const failures: string[] = []
  const createWorktree = createSemaphore(1, createAgentWorktree)
  let originBranchPromise: Promise<string | undefined> | undefined

  function getUnpushedBranch(): Promise<string | undefined> {
    return (originBranchPromise ??= (async () => {
      const cwd = getCwd()
      const branch = await getBranch()
      if (branch === 'HEAD') {
        return undefined
      }
      if (await isBranchOnOrigin(branch, cwd)) {
        return branch
      }
      onProgress({
        type: 'progress',
        toolUseID: 'workflow_log',
        data: {
          type: 'workflow_log',
          message: `local branch '${branch}' is not pushed to origin; remote agents will run against the repository's default branch.`,
        },
      })
      return undefined
    })())
  }
  void getUnpushedBranch

  function assertAgentCap(): void {
    if (agentCount < WORKFLOW_AGENT_CAP) {
      return
    }
    if (!agentCapLogged) {
      agentCapLogged = true
      logEvent('tengu_workflow_agent_cap_exceeded', { agentCount })
    }
    throw new WorkflowAgentCapError()
  }

  function assertBudget(): void {
    if (tokenBudget?.total == null || tokenBudget.total <= 0) {
      return
    }
    const spent = tokenBudget.getTurnSpent()
    if (spent < tokenBudget.total) {
      return
    }
    if (!budgetCapLogged) {
      budgetCapLogged = true
      logEvent('tengu_workflow_budget_cap_exceeded', {
        spent,
        budget: tokenBudget.total,
        agentCount,
      })
    }
    throw new WorkflowBudgetExceededError(spent, tokenBudget.total)
  }

  let phaseIndex = 0
  const phaseMap = new Map<string, number>()
  const isolatedContext = {
    ...context,
    setAppState: () => {},
    setToolPermissionContext: () => {},
  } as ToolUseContext

  function resolvePhase(title: string, kind?: string): number {
    let index = phaseMap.get(title)
    if (index == null) {
      index = ++phaseIndex
      phaseMap.set(title, index)
      onProgress({
        type: 'progress',
        toolUseID: `workflow_phase_${index}`,
        data: { type: 'workflow_phase', index, title, kind },
      })
    }
    return index
  }
  for (const title of seedPhaseTitles ?? []) {
    resolvePhase(title)
  }

  const phase = sealFn((title: unknown) => {
    currentPhase = String(title)
    resolvePhase(currentPhase)
  })

  const isolatedLocal = createSemaphore(
    workflowConcurrency(cpus().length),
    runLocalAgent,
  )

  const agent = sealFn(async (prompt: unknown, opts?: AgentHookOpts) => {
    if (isolatedContext.abortController?.signal.aborted) {
      throw new Error('Workflow aborted')
    }
    assertAgentCap()
    assertBudget()
    const index = ++agentCount
    const promptText = String(prompt)
    const label =
      opts?.label != null
        ? String(opts.label)
        : promptText.slice(0, 60).replace(/\s+/g, ' ').trim()
    const phaseTitle = opts?.phase != null ? String(opts.phase) : currentPhase
    const phaseIdx = phaseTitle ? resolvePhase(phaseTitle) : undefined
    const stallMs =
      opts?.stallMs != null ? Number(opts.stallMs) : WORKFLOW_STALL_MS
    const promptPreview = previewValue(promptText)
    let cacheKey: string | undefined
    let startedAgentId: string | undefined
    if (journal) {
      cacheKey = journalKey(promptText, opts, journalChain)
      journalChain = cacheKey
      const cached = pastCachePrefix ? undefined : journalState?.results.get(cacheKey)
      if (cached !== undefined) {
        onProgress({
          type: 'progress',
          toolUseID: `workflow_agent_${index}_cached`,
          data: {
            type: 'workflow_agent',
            index,
            label,
            phaseIndex: phaseIdx,
            phaseTitle,
            agentId: cached.agentId,
            model:
              typeof opts?.model === 'string'
                ? opts.model
                : isolatedContext.options.mainLoopModel,
            state: 'done',
            startedAt: Date.now(),
            lastProgressAt: Date.now(),
            cached: true,
            resultPreview: previewValue(cached.result),
            promptPreview,
          },
        })
        return structuredClone(cached.result)
      }
      pastCachePrefix = true
      const started = journalState?.started.get(cacheKey)
      if (started && started.length > 0) {
        logEvent('tengu_workflow_journal_started_hit_respawn', {
          attempts: started.length,
        })
      }
    }
    let recordedStart = false
    const onStart = (agentId: string) => {
      recordedStart = true
      startedAgentId = agentId
      if (!journal) {
        return
      }
      journal
        .append({ type: 'started', key: cacheKey!, agentId })
        .catch(error =>
          logForDebugging(`workflow journal started-append failed: ${error}`, {
            level: 'warn',
          }),
        )
    }
    const persistResult = async (value: unknown) => {
      if (journal && cacheKey && value !== null) {
        await journal
          .append({
            type: 'result',
            key: cacheKey,
            agentId: startedAgentId ?? '',
            result: value,
          })
          .catch(error =>
            logForDebugging(`workflow journal result-append failed: ${error}`, {
              level: 'warn',
            }),
          )
      }
      return value
    }
    const queuedAt = Date.now()
    if (opts?.isolation === 'remote') {
      throw new Error("agent({isolation:'remote'}) is not available in this build")
    }
    onProgress({
      type: 'progress',
      toolUseID: `workflow_agent_${index}_queued`,
      data: {
        type: 'workflow_agent',
        index,
        label,
        phaseIndex: phaseIdx,
        phaseTitle,
        agentType: opts?.agentType != null ? String(opts.agentType) : undefined,
        isolation:
          opts?.isolation === 'worktree' || opts?.isolation === 'remote'
            ? String(opts.isolation)
            : undefined,
        model:
          typeof opts?.model === 'string'
            ? opts.model
            : isolatedContext.options.mainLoopModel,
        state: 'start',
        queuedAt,
        promptPreview,
        lastProgressAt: queuedAt,
      },
    })
    try {
      return await persistResult(
        await isolatedLocal(
          index,
          promptText,
          label,
          phaseTitle,
          phaseIdx,
          stallMs,
          opts,
          onStart,
          queuedAt,
        ),
      )
    } catch (error) {
      if (!recordedStart && !isolatedContext.abortController?.signal.aborted) {
        onProgress({
          type: 'progress',
          toolUseID: `workflow_agent_${index}_queued`,
          data: {
            type: 'workflow_agent',
            index,
            label,
            phaseIndex: phaseIdx,
            phaseTitle,
            model:
              typeof opts?.model === 'string'
                ? opts.model
                : isolatedContext.options.mainLoopModel,
            state: 'error',
            error: error instanceof Error ? error.message : String(error),
            queuedAt,
            promptPreview,
            lastProgressAt: Date.now(),
          },
        })
      }
      throw error
    }
  })

  async function runLocalAgent(
    index: number,
    prompt: string,
    label: string,
    phaseTitle: string,
    phaseIdx: number | undefined,
    stallMs: number,
    opts: AgentHookOpts | undefined,
    onStart: (agentId: string) => void,
    queuedAt: number,
  ): Promise<unknown> {
    if (isolatedContext.abortController?.signal.aborted) {
      throw new Error('Workflow aborted')
    }
    assertBudget()
    let agentDefinition: AgentDefinition | undefined
    if (opts?.agentType != null) {
      const agentType = String(opts.agentType)
      const active = isolatedContext.options.agentDefinitions.activeAgents
      const permission = isolatedContext.getAppState().toolPermissionContext
      const allowed = filterDeniedAgents(active, permission, AGENT_TOOL_NAME)
      const found = allowed.find(item => item.agentType === agentType)
      if (!found) {
        if (active.some(item => item.agentType === agentType)) {
          const rule = getDenyRuleForAgent(
            permission,
            AGENT_TOOL_NAME,
            agentType,
          )
          throw new Error(
            `agent({agentType}): '${agentType}' is denied by permission rule '${AGENT_TOOL_NAME}(${agentType})' from ${rule?.source ?? 'settings'}.`,
          )
        }
        throw new Error(
          `agent({agentType}): agent type '${agentType}' not found. Available agents: ${allowed.map(item => item.agentType).join(', ')}`,
        )
      }
      const disallowed = [
        ...(found.disallowedTools ?? []),
        ...(['SendUserMessage', AGENT_TOOL_NAME] as string[]),
      ]
      const suffix = opts.schema ? WORKFLOW_SCHEMA_NOTE : WORKFLOW_CUSTOM_AGENT_NOTE
      const tools =
        opts.schema &&
        found.tools !== undefined &&
        !(found.tools.length === 1 && found.tools[0] === '*')
          ? [...found.tools, SYNTHETIC_OUTPUT_TOOL_NAME]
          : found.tools
      agentDefinition = isBuiltInAgent(found)
        ? {
            ...found,
            disallowedTools: disallowed,
            tools,
            getSystemPrompt: params => found.getSystemPrompt(params) + suffix,
          }
        : {
            ...found,
            disallowedTools: disallowed,
            tools,
            getSystemPrompt: () => found.getSystemPrompt() + suffix,
          }
    }
    let schemaTool: Tool | undefined
    if (opts?.schema) {
      const created = createSyntheticOutputTool(
        opts.schema as Record<string, unknown>,
      )
      if ('error' in created) {
        throw new TypeError(
          `agent({schema}) received an invalid JSON Schema: ${created.error}`,
        )
      }
      schemaTool = created.tool
    }
    const definition =
      agentDefinition ?? defaultWorkflowAgent(Boolean(schemaTool))
    const appState = isolatedContext.getAppState()
    const permission = {
      ...isolatedContext.getAppState().toolPermissionContext,
      mode: definition.permissionMode ?? 'acceptEdits',
    }
    const parentMcp = isolatedContext.options.tools.filter(isMcpTool)
    const mcpTools = [...appState.mcp.tools, ...parentMcp]
    const byName = new Map<string, Tool>()
    for (const tool of isolatedContext.options.tools) {
      byName.set(tool.name, tool)
    }
    for (const tool of mcpTools) {
      if (!byName.has(tool.name)) {
        byName.set(tool.name, tool)
      }
    }
    let availableTools: Tools = [...byName.values()]
    if (schemaTool) {
      availableTools = [
        ...availableTools.filter(
          tool => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
        ),
        schemaTool,
      ]
    }
    const model = getAgentModel(
      definition.model,
      isolatedContext.options.mainLoopModel,
      typeof opts?.model === 'string' ? (opts.model as ModelAlias) : undefined,
      permission.mode,
    )
    let worktree:
      | Awaited<ReturnType<typeof createAgentWorktree>>
      | undefined
    if (opts?.isolation === 'worktree') {
      const slug = workflowRunId
        ? `${workflowRunId}-${index}`
        : `wf-${index}`
      worktree = await createWorktree(slug)
    }
    const worktreePath = worktree?.worktreePath
    const agentPrompt = worktree
      ? `${prompt}

---
You are running in an isolated git worktree at ${worktree.worktreePath} (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (${getCwd()}) or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.`
      : prompt
    let accTokens = 0
    let accToolCalls = 0
    let accDuration = 0
    const startedAt = Date.now()
    const promptPreview = previewValue(prompt)

    async function runOnce(
      runPrompt: string,
      runLabel: string,
      attempt: number,
      lastAttemptReason?: string,
    ): Promise<AgentRunResult> {
      const agentId = createAgentId()
      onStart(agentId)
      const toolUseID = `workflow_agent_${index}_${agentId}`
      let lastToolName: string | undefined
      let lastToolSummary: string | undefined
      const emit = (
        state: string,
        extra?: Partial<Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>>,
      ) =>
        onProgress({
          type: 'progress',
          toolUseID,
          data: {
            type: 'workflow_agent',
            index,
            label: runLabel,
            phaseIndex: phaseIdx,
            phaseTitle,
            agentId,
            agentType: agentDefinition?.agentType,
            isolation: worktree ? 'worktree' : undefined,
            model,
            state,
            startedAt,
            queuedAt,
            attempt,
            lastAttemptReason,
            lastToolName,
            lastToolSummary,
            promptPreview,
            lastProgressAt: Date.now(),
            ...extra,
          },
        })
      const agentAbort = new AbortController()
      const parentSignal = isolatedContext.abortController?.signal
      const onParentAbort = () => agentAbort.abort('workflow-abort')
      if (parentSignal?.aborted) {
        agentAbort.abort('workflow-abort')
      }
      parentSignal?.addEventListener('abort', onParentAbort)
      onAgentController?.(agentId, agentAbort)
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      let lastProgressAt = 0
      const minGap = Math.min(stallMs * 0.1, 1000)
      const armStall = () => {
        if (stallTimer) {
          clearTimeout(stallTimer)
        }
        if (stallMs > 0) {
          stallTimer = setTimeout(
            controller => controller.abort('stalled'),
            stallMs,
            agentAbort,
          )
        }
      }
      const onQueryProgress = () => {
        const now = Date.now()
        if (now - lastProgressAt < minGap) {
          return
        }
        lastProgressAt = now
        armStall()
      }
      const agentContext = {
        ...isolatedContext,
        abortController: agentAbort,
      } as ToolUseContext
      let structuredNudgeFails = 0
      if (schemaTool) {
        addFunctionHook(
          context.setAppState,
          agentId,
          'SubagentStop',
          '',
          messages => {
            if (structuredNudgeFails >= 2) {
              return true
            }
            const ok = hasSuccessfulToolCall(
              messages,
              SYNTHETIC_OUTPUT_TOOL_NAME,
            )
            if (!ok) {
              structuredNudgeFails++
            }
            return ok
          },
          `You did not call ${SYNTHETIC_OUTPUT_TOOL_NAME}. You MUST call ${SYNTHETIC_OUTPUT_TOOL_NAME} to return your answer — the tool input IS your answer. Call it now.`,
          { timeout: 5000 },
        )
      }
      emit(
        'start',
        accTokens || accToolCalls
          ? { tokens: accTokens, toolCalls: accToolCalls }
          : undefined,
      )
      armStall()
      let lastAssistant: AssistantMessage | undefined
      let structured: unknown
      let turnTokens = 0
      let turnToolCalls = 0
      let structuredAttempts = 0
      let lastStructuredInput: unknown
      const turnStarted = Date.now()
      const parent = getAgentContext()
      const workflowAgentContext = {
        agentId,
        parentAgentId: parent?.agentId,
        depth: (parent?.depth ?? 0) + 1,
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: definition.agentType,
        isBuiltIn: isBuiltInAgent(definition),
      }
      try {
        await runWithAgentContext(workflowAgentContext, async () => {
        for await (const message of runAgent({
          agentDefinition: definition,
          promptMessages: [createUserMessage({ content: runPrompt })],
          toolUseContext: agentContext,
          canUseTool,
          isAsync: false,
          querySource: getQuerySourceForAgent(
            definition.agentType,
            isBuiltInAgent(definition),
          ),
          spawnedBySkill:
            isolatedContext.options.spawnedBySkill ??
            (isolatedContext.options as { activeSkill?: string }).activeSkill,
          availableTools,
          transcriptSubdir: workflowRunId
            ? `workflows/${workflowRunId}`
            : undefined,
          spawnedByWorkflowRunId: workflowRunId,
          override: { agentId },
          model:
            typeof opts?.model === 'string'
              ? (opts.model as ModelAlias)
              : undefined,
          onQueryProgress,
        })) {
          if (
            message.type === 'attachment' &&
            'attachment' in message &&
            message.attachment.type === 'structured_output'
          ) {
            structured = message.attachment.data
            continue
          }
          if (message.type === 'assistant') {
            lastAssistant = message
            turnTokens = getTokenCountFromUsage(message.message.usage)
            let toolUses = 0
            for (const block of message.message.content) {
              if (block.type !== 'tool_use') {
                continue
              }
              toolUses++
              lastToolName = block.name
              lastToolSummary = toolInputSummary(block.input) || undefined
              if (block.name === SYNTHETIC_OUTPUT_TOOL_NAME) {
                structuredAttempts++
                lastStructuredInput = block.input
              }
            }
            turnToolCalls += toolUses
            if (toolUses > 0) {
              if (stallTimer) {
                clearTimeout(stallTimer)
              }
              stallTimer = undefined
            } else {
              onQueryProgress()
            }
            emit('progress', {
              tokens: accTokens + turnTokens,
              toolCalls: accToolCalls + turnToolCalls,
            })
          }
        }
        })
      } catch (error) {
        const reason = agentAbort.signal.aborted
          ? agentAbort.signal.reason
          : undefined
        if (reason === 'stalled' || reason === 'user-retry') {
          if (reason === 'stalled' && structured !== undefined) {
            const durationMs = Date.now() - turnStarted
            emit('done', {
              tokens: accTokens + turnTokens,
              toolCalls: accToolCalls + turnToolCalls,
              durationMs: accDuration + durationMs,
              resultPreview: previewValue(structured),
            })
            return {
              structured,
              text: '',
              tokens: turnTokens,
              toolCalls: turnToolCalls,
              stalled: false,
              skipped: false,
              durationMs,
              stopReason: undefined,
              outputTokens: undefined,
              structuredOutputAttempts: structuredAttempts,
              lastStructuredOutputInput: lastStructuredInput,
            }
          }
          emit('error', {
            error:
              reason === 'stalled'
                ? `stalled — no progress for ${stallMs}ms`
                : 'retry requested by user',
            tokens: accTokens + turnTokens,
            toolCalls: accToolCalls + turnToolCalls,
            durationMs: accDuration + (Date.now() - turnStarted),
          })
          return {
            structured: undefined,
            text: '',
            tokens: turnTokens,
            toolCalls: turnToolCalls,
            stalled: true,
            stalledReason: String(reason),
            skipped: false,
            durationMs: Date.now() - turnStarted,
            stopReason: undefined,
            outputTokens: undefined,
            structuredOutputAttempts: structuredAttempts,
            lastStructuredOutputInput: lastStructuredInput,
          }
        }
        if (reason === 'user-skip') {
          emit('error', {
            error: 'skipped by user',
            skipped: true,
            tokens: accTokens + turnTokens,
            toolCalls: accToolCalls + turnToolCalls,
            durationMs: accDuration + (Date.now() - turnStarted),
          })
          return {
            structured: undefined,
            text: '',
            tokens: turnTokens,
            toolCalls: turnToolCalls,
            stalled: false,
            skipped: true,
            durationMs: Date.now() - turnStarted,
            stopReason: undefined,
            outputTokens: undefined,
            structuredOutputAttempts: structuredAttempts,
            lastStructuredOutputInput: lastStructuredInput,
          }
        }
        emit('error', {
          error: error instanceof Error ? error.message : String(error),
          tokens: accTokens + turnTokens,
          toolCalls: accToolCalls + turnToolCalls,
          durationMs: accDuration + (Date.now() - turnStarted),
        })
        throw error
      } finally {
        if (stallTimer) {
          clearTimeout(stallTimer)
        }
        parentSignal?.removeEventListener('abort', onParentAbort)
        onAgentController?.(agentId, null)
        if (schemaTool) {
          clearSessionHooks(context.setAppState, agentId)
        }
      }
      const text = lastAssistant
        ? extractTextContent(
            lastAssistant.message.content as ReadonlyArray<{
              readonly type: string
            }>,
            '\n',
          )
        : ''
      const outputTokens =
        lastAssistant?.message.usage &&
        typeof lastAssistant.message.usage.output_tokens === 'number'
          ? lastAssistant.message.usage.output_tokens
          : undefined
      const durationMs = Date.now() - turnStarted
      emit('done', {
        tokens:
          accTokens +
          (turnTokens ||
            (lastAssistant
              ? getTokenCountFromUsage(lastAssistant.message.usage)
              : 0)),
        toolCalls: accToolCalls + turnToolCalls,
        durationMs: accDuration + durationMs,
        resultPreview: previewValue(schemaTool ? structured : text),
      })
      return {
        structured,
        text,
        tokens: turnTokens,
        toolCalls: turnToolCalls,
        stalled: false,
        skipped: false,
        durationMs,
        stopReason: lastAssistant?.message.stop_reason,
        outputTokens,
        structuredOutputAttempts: structuredAttempts,
        lastStructuredOutputInput: lastStructuredInput,
      }
    }

    try {
      let result = await runWithCwd(worktreePath ?? getCwd(), () =>
        runOnce(agentPrompt, label, 1),
      )
      const isThrottled = (run: AgentRunResult) =>
        !run.stalled &&
        !run.skipped &&
        run.stopReason == null &&
        run.structured === undefined &&
        (run.outputTokens ?? Infinity) < 50 &&
        run.durationMs > stallMs * 0.5
      let throttled = isThrottled(result)
      if (throttled) {
        onProgress({
          type: 'progress',
          toolUseID: 'workflow_log',
          data: {
            type: 'workflow_log',
            message: `[${index}] throttled response (no stop_reason, ${result.outputTokens ?? '?'} output tokens in ${Math.round(result.durationMs / 1000)}s) — sleeping 45s before retry`,
          },
        })
        await sleep(45_000, isolatedContext.abortController?.signal, {
          throwOnAbort: true,
        })
        accTokens += result.tokens
        accToolCalls += result.toolCalls
        accDuration += result.durationMs
        result = await runWithCwd(worktreePath ?? getCwd(), () =>
          runOnce(agentPrompt, `${label} (throttle-retry)`, 2, 'throttled'),
        )
        if (isThrottled(result)) {
          onProgress({
            type: 'progress',
            toolUseID: 'workflow_log',
            data: {
              type: 'workflow_log',
              message: `[${index}] throttle-retry also degraded — giving up on throttle backoff`,
            },
          })
        }
      }
      const reasons: string[] = []
      for (let retry = 1; result.stalled && !throttled && retry <= WORKFLOW_STALL_RETRIES; retry++) {
        if (isolatedContext.abortController?.signal.aborted) {
          throw new Error('Workflow aborted')
        }
        const reason = result.stalledReason ?? 'stalled'
        reasons.push(reason)
        const why =
          reason === 'user-retry'
            ? 'retry requested by user'
            : 'stalled (no progress)'
        let extra = ''
        if (
          reason === 'stalled' &&
          result.structuredOutputAttempts > 0 &&
          result.structured === undefined
        ) {
          const last = jsonStringify(result.lastStructuredOutputInput)
          const clipped =
            last.length > 300 ? last.slice(0, 300) + '\u2026' : last
          extra = ` — ${result.structuredOutputAttempts} StructuredOutput validation ${plural(result.structuredOutputAttempts, 'failure')} (last input: ${clipped})`
        }
        onProgress({
          type: 'progress',
          toolUseID: 'workflow_log',
          data: {
            type: 'workflow_log',
            message: `[stall] agent "${label}" ${why} after ${Math.round(result.durationMs / 1000)}s${extra} — retrying (${retry}/${WORKFLOW_STALL_RETRIES})`,
          },
        })
        accTokens += result.tokens
        accToolCalls += result.toolCalls
        accDuration += result.durationMs
        result = await runWithCwd(worktreePath ?? getCwd(), () =>
          runOnce(agentPrompt, `${label} (retry ${retry})`, retry + 1, reason),
        )
      }
      if (result.skipped) {
        return null
      }
      if (result.stalled) {
        reasons.push(result.stalledReason ?? 'stalled')
        const n = reasons.length
        const allRetry = reasons.every(item => item === 'user-retry')
        const allStall = reasons.every(item => item === 'stalled')
        const schemaNote =
          result.stalledReason !== 'user-retry' &&
          result.structuredOutputAttempts > 0 &&
          result.structured === undefined
            ? ` — ${result.structuredOutputAttempts} StructuredOutput validation ${plural(result.structuredOutputAttempts, 'failure')} on the last attempt`
            : ''
        throw new Error(
          allRetry
            ? `agent abandoned: user requested retry on all ${n} attempts`
            : allStall
              ? `agent stalled on all ${n} attempts (no progress for ${stallMs}ms each)${schemaNote}`
              : `agent abandoned after ${n} attempts (${reasons.join(' \u2192 ')})${schemaNote}`,
        )
      }
      if (schemaTool) {
        if (result.structured === undefined) {
          throw new Error(
            'agent({schema}): subagent completed without calling StructuredOutput (after 2 in-conversation nudges)',
          )
        }
        return structuredClone(result.structured)
      }
      return result.text
    } finally {
      if (worktree) {
        const {
          worktreePath: path,
          worktreeBranch,
          headCommit,
          gitRoot,
          hookBased,
        } = worktree
        try {
          if (
            !hookBased &&
            headCommit &&
            !(await hasWorktreeChanges(path, headCommit))
          ) {
            await removeAgentWorktree(path, worktreeBranch, gitRoot, false)
          }
        } catch {
          // official swallows cleanup errors
        }
      }
    }
  }

  const parallel = sealFn(async (thunks: unknown) => {
    if (!Array.isArray(thunks)) {
      throw new TypeError('parallel() expects an array of functions')
    }
    if (thunks.length === 0) {
      return []
    }
    assertAgentCap()
    assertBudget()
    for (const thunk of thunks) {
      if (typeof thunk !== 'function') {
        throw new TypeError(
          'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)',
        )
      }
    }
    const settled = await Promise.allSettled(
      thunks.map(thunk => vmAwait((thunk as () => unknown)())),
    )
    let budgetDrops = 0
    const values = settled.map((item, index) => {
      if (item.status === 'fulfilled') {
        return item.value
      }
      if (item.reason instanceof WorkflowBudgetExceededError) {
        budgetDrops++
        return null
      }
      const message =
        item.reason instanceof Error ? item.reason.message : String(item.reason)
      const line = `parallel[${index}] failed: ${message}`
      failures.push(line)
      onProgress({
        type: 'progress',
        toolUseID: 'workflow_log',
        data: { type: 'workflow_log', message: line },
      })
      return null
    })
    if (budgetDrops > 0) {
      failures.push(
        `parallel: ${budgetDrops} ${plural(budgetDrops, 'slot')} dropped — token budget exceeded`,
      )
    }
    return values
  })

  const pipeline = sealFn(async (items: unknown, ...stages: unknown[]) => {
    if (!Array.isArray(items)) {
      throw new TypeError('pipeline() expects an array as the first argument')
    }
    if (items.length === 0) {
      return []
    }
    assertAgentCap()
    assertBudget()
    for (const stage of stages) {
      if (typeof stage !== 'function') {
        throw new TypeError(
          'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)',
        )
      }
    }
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        let current: unknown = item
        for (const stage of stages) {
          if (current === null) {
            break
          }
          current = await vmAwait(
            (stage as (prev: unknown, original: unknown, index: number) => unknown)(
              current,
              item,
              index,
            ),
          )
        }
        return current
      }),
    )
    let budgetDrops = 0
    const values = settled.map((item, index) => {
      if (item.status === 'fulfilled') {
        return item.value
      }
      if (item.reason instanceof WorkflowBudgetExceededError) {
        budgetDrops++
        return null
      }
      const message =
        item.reason instanceof Error ? item.reason.message : String(item.reason)
      const line = `pipeline[${index}] failed: ${message}`
      failures.push(line)
      onProgress({
        type: 'progress',
        toolUseID: 'workflow_log',
        data: { type: 'workflow_log', message: line },
      })
      return null
    })
    if (budgetDrops > 0) {
      failures.push(
        `pipeline: ${budgetDrops} ${plural(budgetDrops, 'slot')} dropped — token budget exceeded`,
      )
    }
    return values
  })

  const log = sealFn((message: unknown) => {
    onProgress({
      type: 'progress',
      toolUseID: 'workflow_log',
      data: { type: 'workflow_log', message: String(message) },
    })
  })

  return {
    agent,
    parallel,
    pipeline,
    log,
    phase,
    resolvePhase,
    recordFailure: message => {
      failures.push(message)
    },
    getAgentCount: () => agentCount,
    getFailures: () => failures,
    bindVMAwait: fn => {
      vmAwait = fn
    },
  }
}

/** Official 2.1.153 `Eq4`. */
function createChildWorkflow(opts: {
  hooks: WorkflowHooks
  budget: { total: number | null; spent: () => number; remaining: () => number }
  abortSignal?: AbortSignal
  timers: { setTimeout: (fn: () => void, ms?: number) => number; clearTimeout: (id: number) => void }
}): (nameOrRef: unknown, args?: unknown) => Promise<unknown> {
  const counts = new Map<string, number>()
  const childGlobals = {
    parallel: opts.hooks.parallel,
    pipeline: opts.hooks.pipeline,
    budget: opts.budget,
    workflow: sealFn(() =>
      Promise.reject(
        new Error(
          'workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.',
        ),
      ),
    ),
    ...opts.timers,
  }
  return sealFn(async (nameOrRef: unknown, args?: unknown) => {
    if (opts.abortSignal?.aborted) {
      throw new Error('Workflow aborted')
    }
    let scriptBody: string
    let name: string | undefined
    if (typeof nameOrRef === 'string') {
      const found = await findWorkflowByName(nameOrRef, getCwd())
      if (!found) {
        const available = (await listWorkflows(getCwd()))
          .map(item => item.name)
          .join(', ')
        throw new Error(
          `workflow('${nameOrRef}'): no workflow with that name. Available: ${available || '(none)'}`,
        )
      }
      const parsed = parseWorkflowScript(found.script)
      if ('error' in parsed) {
        throw new Error(`workflow('${nameOrRef}'): ${parsed.error}`)
      }
      name = found.name
      scriptBody = parsed.scriptBody
    } else if (
      nameOrRef &&
      typeof nameOrRef === 'object' &&
      'scriptPath' in nameOrRef &&
      typeof (nameOrRef as { scriptPath: unknown }).scriptPath === 'string'
    ) {
      const scriptPath = (nameOrRef as { scriptPath: string }).scriptPath
      const fromDisk = await readWorkflowScriptPath(scriptPath)
      if ('error' in fromDisk) {
        throw new Error(
          `workflow({scriptPath: '${scriptPath}'}): ${fromDisk.error}`,
        )
      }
      const parsed = parseWorkflowScript(fromDisk.script)
      if ('error' in parsed) {
        throw new Error(
          `workflow({scriptPath: '${scriptPath}'}): ${parsed.error}`,
        )
      }
      name = parsed.meta.name
      scriptBody = parsed.scriptBody
    } else {
      throw new TypeError(
        'workflow() expects a workflow name (string) or {scriptPath: string}',
      )
    }
    const compiled = compileWorkflowScript(scriptBody)
    if (compiled.ok === false) {
      throw new Error(`workflow('${name}'): ${compiled.error}`)
    }
    const n = (counts.get(name) ?? 0) + 1
    counts.set(name, n)
    const phaseTitle = `${WORKFLOW_CHILD_MARK} ${name}${n > 1 ? ` #${n}` : ''}`
    opts.hooks.resolvePhase(phaseTitle, 'child')
    opts.hooks.log(`${WORKFLOW_CHILD_MARK} running dynamic workflow ${name}`)
    const prefix = `[${name}] `
    const child = {
      ...childGlobals,
      agent: sealFn((prompt: unknown, agentOpts?: AgentHookOpts) =>
        opts.hooks.agent(prompt, { ...agentOpts, phase: phaseTitle }),
      ),
      phase: sealFn((_title: unknown) => {}),
      log: sealFn((message: unknown) => opts.hooks.log(prefix + String(message))),
      console: createWorkflowConsole(message =>
        opts.hooks.log(prefix + message),
      ),
      args,
    }
    try {
      const vmContext = vm.createContext(child)
      installWorkflowShims(vmContext)
      freezeWorkflowContext(vmContext)
      const raw = await compiled.vmScript.runInContext(vmContext, {
        timeout: WORKFLOW_SYNC_TIMEOUT_MS,
      })
      const result = structuredClone(raw)
      opts.hooks.log(`${WORKFLOW_CHILD_MARK} ${name} done`)
      return result
    } catch (error) {
      const message = formatWorkflowError(error)
      opts.hooks.recordFailure(`${phaseTitle}: ${message}`)
      opts.hooks.log(`${WORKFLOW_CHILD_MARK} ${name} failed: ${message}`)
      throw error
    }
  })
}

/** Official 2.1.153 `gK4`. */
function createWorkflowVm(
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  onProgress: (message: WorkflowProgressMessage) => void,
  workflowRunId: string | undefined,
  onAgentController: ((agentId: string, controller: AbortController | null) => void) | undefined,
  args: unknown,
  seedPhaseTitles: string[] | undefined,
  tokenBudget: TokenBudget | undefined,
  journal: LocalFileJournal | undefined,
  journalState: JournalState | undefined,
): { vmContext: vm.Context; hooks: WorkflowHooks } {
  const hooks = createWorkflowHooks(
    context,
    canUseTool,
    onProgress,
    workflowRunId,
    onAgentController,
    seedPhaseTitles,
    tokenBudget,
    journal,
    journalState,
  )
  const consoleApi = createWorkflowConsole(message =>
    onProgress({
      type: 'progress',
      toolUseID: 'workflow_log',
      data: { type: 'workflow_log', message },
    }),
  )
  const budget = Object.freeze({
    total: tokenBudget?.total ?? null,
    spent: sealFn(() => tokenBudget?.getTurnSpent() ?? 0),
    remaining: sealFn(() =>
      tokenBudget?.total == null
        ? Infinity
        : Math.max(0, tokenBudget.total - tokenBudget.getTurnSpent()),
    ),
  })
  const abortSignal = context.abortController?.signal
  const timers = createAbortTimers(abortSignal)
  const workflow = createChildWorkflow({
    hooks,
    budget,
    abortSignal,
    timers,
  })
  const vmContext = vm.createContext({
    agent: hooks.agent,
    parallel: hooks.parallel,
    pipeline: hooks.pipeline,
    log: hooks.log,
    phase: hooks.phase,
    workflow,
    args,
    budget,
    console: consoleApi,
    ...timers,
  })
  installWorkflowShims(vmContext)
  freezeWorkflowContext(vmContext)
  hooks.bindVMAwait(createVmAwait(vmContext))
  return { vmContext, hooks }
}

export type WorkflowRunResult = {
  result: unknown
  agentCount: number
  logs: string[]
  failures: string[]
  durationMs: number
  error?: string
}

/** Official 2.1.153 `cK4`. */
export async function runCompiledWorkflow(
  vmScript: vm.Script,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  options: {
    workflowRunId?: string
    onProgress?: (message: WorkflowProgressMessage) => void
    onAgentController?: (agentId: string, controller: AbortController | null) => void
    args?: unknown
    seedPhaseTitles?: string[]
    tokenBudget?: TokenBudget
    journal?: LocalFileJournal
    syncTimeoutMs?: number
  } = {},
): Promise<WorkflowRunResult> {
  const started = Date.now()
  const logs: string[] = []
  const onProgress = (message: WorkflowProgressMessage) => {
    if (
      message.type === 'progress' &&
      message.data.type === 'workflow_log' &&
      logs.length < WORKFLOW_LOG_CAP
    ) {
      logs.push(message.data.message)
    }
    options.onProgress?.(message)
  }
  const journalState = options.journal
    ? await options.journal.load()
    : undefined
  const { vmContext, hooks } = createWorkflowVm(
    context,
    canUseTool,
    onProgress,
    options.workflowRunId,
    options.onAgentController,
    options.args,
    options.seedPhaseTitles,
    options.tokenBudget,
    options.journal,
    journalState,
  )
  const abortSignal = context.abortController?.signal
  let removeAbort: (() => void) | undefined
  try {
    const raw = vmScript.runInContext(vmContext, {
      timeout: options.syncTimeoutMs ?? WORKFLOW_SYNC_TIMEOUT_MS,
    })
    const pending = Promise.resolve(raw)
    pending.catch(() => {})
    const raced = abortSignal
      ? await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new Error('Workflow aborted'))
            if (abortSignal.aborted) {
              abort()
            } else {
              abortSignal.addEventListener('abort', abort)
              removeAbort = () => abortSignal.removeEventListener('abort', abort)
            }
          }),
        ])
      : await pending
    const result = structuredClone(raced)
    jsonStringify(result)
    return {
      result,
      agentCount: hooks.getAgentCount(),
      logs,
      failures: hooks.getFailures(),
      durationMs: Date.now() - started,
    }
  } catch (error) {
    if (error instanceof Error && error.stack) {
      logForDebugging(
        `Workflow script error stack trace:\n${error.stack}`,
        { level: 'error' },
      )
    }
    return {
      result: null,
      agentCount: hooks.getAgentCount(),
      logs,
      failures: hooks.getFailures(),
      durationMs: Date.now() - started,
      error: formatWorkflowError(error),
    }
  } finally {
    removeAbort?.()
  }
}

/** Official 2.1.153 `DrH` via existing `emitTaskProgress`. */
export function emitWorkflowProgress(params: {
  taskId: string
  toolUseId?: string
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  lastToolName?: string
  summary?: string
  workflowProgress: WorkflowProgressEvent[]
}): void {
  emitTaskProgress({
    taskId: params.taskId,
    toolUseId: params.toolUseId,
    description: params.description,
    startTime: params.startTime,
    totalTokens: params.totalTokens,
    toolUses: params.toolUses,
    lastToolName: params.lastToolName,
    summary: params.summary,
    workflowProgress: params.workflowProgress as never,
  })
}

export type { LocalWorkflowTaskState }
