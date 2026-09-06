import { readFile, rename, stat, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { isENOENT } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { jobDir, pinsPath } from './paths.js'
import { JobStateSchema, type JobState } from './types.js'

const STATE_JSON = 'state.json'
const cache = new Map<string, { mtimeKey: string; state: JobState | null }>()

/** Official `HJ`. */
export function isSettled(state: JobState): boolean {
  return isTerminalState(state.state) && state.tempo !== 'active'
}

function isTerminalState(state: string): boolean {
  return (
    state === 'done' ||
    state === 'failed' ||
    state === 'stopped' ||
    state === 'killed'
  )
}

/** Official `P1H`. */
export function isBareExec(state: JobState): boolean {
  return state.template === 'exec' && state.respawnFlags.length === 0
}

/** Official `Qf` used by `iz` / `jo_` — write then fsync via writeFile. */
export async function writeAtomic(
  path: string,
  contents: string,
  mode?: number,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, contents, mode !== undefined ? { mode } : undefined)
  try {
    await rename(tmp, path)
  } catch {
    await writeFile(path, contents, mode !== undefined ? { mode } : undefined)
    await rename(tmp, path).catch(() => {})
  }
}

/** Official `iz`. */
export async function writeJobState(
  dir: string,
  next: JobState & { pinned?: boolean; sortOrder?: number; stateSortOrder?: number },
): Promise<void> {
  const { pinned: _p, sortOrder: _s, stateSortOrder: _ss, ...rest } = next
  try {
    await writeAtomic(join(dir, STATE_JSON), jsonStringify(rest, null, 2))
  } finally {
    cache.delete(dir)
  }
}

/** Official `o7`. */
export async function readJobState(dir: string): Promise<JobState | null> {
  const statePath = join(dir, STATE_JSON)
  const orderPath = join(dir, 'order')
  const stateOrderPath = join(dir, 'stateOrder')
  let mtimeKey: string
  try {
    const [a, y, o] = await Promise.all([
      stat(statePath).then(s => s.mtimeMs),
      stat(orderPath).then(s => s.mtimeMs, () => 0),
      stat(stateOrderPath).then(s => s.mtimeMs, () => 0),
    ])
    mtimeKey = `${a}:${y}:${o}`
  } catch (err) {
    if (!isENOENT(err)) {
      logForDebugging(
        `[jobs] skipping ${basename(dir)}: state.json stat failed — ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    }
    cache.delete(dir)
    return null
  }
  const hit = cache.get(dir)
  if (hit?.mtimeKey === mtimeKey) return hit.state
  try {
    const [raw, orderRaw, stateOrderRaw] = await Promise.all([
      readFile(statePath, 'utf-8'),
      readFile(orderPath, 'utf-8').catch(() => null),
      readFile(stateOrderPath, 'utf-8').catch(() => null),
    ])
    const parsed = JobStateSchema.safeParse(safeParseJSON(raw))
    if (!parsed.success) {
      logForDebugging(
        `[jobs] skipping ${basename(dir)}: state.json schema validation failed — ${parsed.error.message}`,
        { level: 'warn' },
      )
      cache.set(dir, { mtimeKey, state: null })
      return null
    }
    let state = parsed.data
    const sortOrder = orderRaw !== null ? Number(orderRaw) : undefined
    const stateSortOrder =
      stateOrderRaw !== null ? Number(stateOrderRaw) : undefined
    if (Number.isFinite(sortOrder)) state = { ...state, sortOrder }
    if (Number.isFinite(stateSortOrder)) {
      state = { ...state, stateSortOrder }
    }
    if (cache.size > 1000) cache.clear()
    cache.set(dir, { mtimeKey, state })
    return state
  } catch (err) {
    if (!isENOENT(err)) {
      logForDebugging(
        `[jobs] skipping ${basename(dir)}: state.json read/parse failed — ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    }
    cache.delete(dir)
    return null
  }
}

/** Official `cvH`. */
export function classifyAndWriteState(
  short: string,
  state: string,
  detail: string,
): Promise<void> {
  const dir = jobDir(short)
  return readJobState(dir).then(cur => {
    if (
      !cur ||
      isSettled(cur) ||
      (state === 'failed' && cur.state === 'blocked' && !isBareExec(cur))
    ) {
      return
    }
    const now = new Date().toISOString()
    return writeJobState(dir, {
      ...cur,
      state,
      detail: state === 'stopped' ? 'stopped' : (cur.detail || detail).replace(/; respawning$/, ''),
      tempo: 'idle',
      inFlight: undefined,
      needs: undefined,
      updatedAt: now,
      firstTerminalAt: cur.firstTerminalAt ?? now,
    })
  }).then(() => {})
}

/** Official `Tw$`. */
export async function readPins(): Promise<Set<string>> {
  try {
    const raw = await readFile(pinsPath(), 'utf-8')
    const parsed = safeParseJSON(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/** Official `kjH`. */
export function bridgeReattachEnv(
  sessionId?: string,
  seq?: number,
  outboundOnly?: boolean,
): Record<string, string> | undefined {
  if (!sessionId) return
  const env: Record<string, string> = {
    CLAUDE_BRIDGE_REATTACH_SESSION: sessionId,
  }
  if (seq !== undefined && seq > 0) {
    env.CLAUDE_BRIDGE_REATTACH_SEQ = String(seq)
  }
  if (outboundOnly !== false) {
    env.CLAUDE_BRIDGE_REATTACH_OUTBOUND_ONLY = '1'
  }
  return env
}

/** Official 2.1.175 `nLH`. */
export async function updateJobRespawnFlag(
  flag: string,
  aliases: string[],
  value: string | null,
): Promise<void> {
  const dir = process.env.CLAUDE_JOB_DIR
  if (!dir || process.env.CLAUDE_CODE_SESSION_KIND !== 'bg') return
  cache.delete(dir)
  const current = await readJobState(dir)
  if (!current?.respawnFlags) return
  const matchFlags = [flag, ...aliases]
  const filter = (flags: string[]) => {
    const res: string[] = []
    for (let i = 0; i < flags.length; i++) {
      const item = flags[i]!
      if (matchFlags.some(f => item === f || item.startsWith(`${f}=`))) {
        if (item.indexOf('=') === -1 && flags[i + 1] !== undefined) {
          i++
        }
        continue
      }
      res.push(item)
    }
    return value === null ? res : [...res, flag, value]
  }
  const next = filter(current.respawnFlags)
  if (
    next.length === current.respawnFlags.length &&
    next.every((v, i) => v === current.respawnFlags[i])
  ) {
    return
  }
  cache.delete(dir)
  const fresh = (await readJobState(dir)) ?? current
  await writeJobState(dir, {
    ...fresh,
    respawnFlags: filter(fresh.respawnFlags ?? current.respawnFlags),
    updatedAt: new Date().toISOString(),
  }).catch(err => {
    if (!isENOENT(err)) {
      logForDebugging(
        `updateJobRespawnFlag failed: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    }
  })
}

/** Official 2.1.175 `IJ7`. */
export async function appendJobRespawnFlag(
  flag: string,
  value: string,
): Promise<void> {
  const dir = process.env.CLAUDE_JOB_DIR
  if (!dir || process.env.CLAUDE_CODE_SESSION_KIND !== 'bg') return
  cache.delete(dir)
  const current = await readJobState(dir)
  if (!current?.respawnFlags) return
  for (let i = 0; i < current.respawnFlags.length - 1; i++) {
    if (
      current.respawnFlags[i] === flag &&
      current.respawnFlags[i + 1] === value
    ) {
      return
    }
  }
  cache.delete(dir)
  const fresh = (await readJobState(dir)) ?? current
  await writeJobState(dir, {
    ...fresh,
    respawnFlags: [...(fresh.respawnFlags ?? []), flag, value],
    updatedAt: new Date().toISOString(),
  }).catch(err => {
    if (!isENOENT(err)) {
      logForDebugging(
        `appendJobRespawnFlag failed: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    }
  })
}
