import { randomBytes } from 'crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { basename, isAbsolute, join, relative, sep } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import { createSkillCommand, clearSkillCaches } from '../../skills/loadSkillsDir.js'
import type { Command, PromptCommand } from '../../types/command.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { isEnvTruthy, getClaudeConfigHomeDir } from '../envUtils.js'
import { extractZipToDirectory } from '../plugins/zipCache.js'
import { createSignal } from '../signal.js'
import { sleep } from '../sleep.js'
import { jsonStringify } from '../slowOperations.js'
import {
  downloadSkillZip,
  listRemoteSkills,
  type SyncedSkillRecord,
} from './skillsSyncApi.js'

/**
 * Official 2.1.149 `tEH`. Remote skills-sync gate.
 */
export function isSkillsSyncEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SYNC_SKILLS)
}

/**
 * Official 2.1.149 `UD9`. Wait timeout for skills sync; default 5000.
 */
export function getSkillsSyncWaitTimeoutMs(): number {
  const parsed = parseInt(
    process.env.CLAUDE_CODE_SYNC_SKILLS_WAIT_TIMEOUT_MS || '',
    10,
  )
  return parsed > 0 ? parsed : 5000
}

type SyncWaitResult = { ok: true } | { ok: false; reason: string }
type SyncWait = {
  promise: Promise<SyncWaitResult>
  resolve: (result: SyncWaitResult) => void
}

type Manifest = {
  lastUpdated: number
  skills: SyncedSkillRecord[]
}

type DiffResult = {
  toDownload: Array<{ skill: SyncedSkillRecord; prev: SyncedSkillRecord | undefined }>
  toRemove: SyncedSkillRecord[]
  carryover: SyncedSkillRecord[]
  liveDirs: Set<string>
}

/** Official 2.1.149 `KNA`. */
const SYNC_INTERVAL_MS = 600_000
/** Official 2.1.149 `BD9`. */
const DOWNLOAD_CONCURRENCY = 15
/** Official 2.1.149 `_NA`. */
const MANIFEST_FILENAME = 'manifest.json'

/** Official 2.1.149 `Bw8` / `sEH`. */
const pendingWaits = new Map<string, SyncWait>()
const syncedSkills = new Map<string, Command>()

/** Official 2.1.149 `fy$` / `FD9` / `H7q` / `$7q`. */
let inFlightSync: Promise<void> | null = null
let firstSyncKickoff: Promise<void> | null = null
let firstSyncWait: { promise: Promise<void>; resolve: () => void } | null = null
let syncInterval: ReturnType<typeof setInterval> | null = null

/** Official 2.1.149 `gLH` (local; REPL `skillChangeDetector` emit is out of scope). */
const skillsSyncChanged = createSignal()

/** Official 2.1.149 `Lr7`. */
function registerPendingWait(name: string): (result: SyncWaitResult) => void {
  let resolve!: (result: SyncWaitResult) => void
  const promise = new Promise<SyncWaitResult>(r => {
    resolve = r
  })
  pendingWaits.set(name, { promise, resolve })
  return resolve
}

/** Official 2.1.149 `pw8`. Resolves immediately unless a download is pending. */
export function waitForSyncedSkill(name: string): Promise<SyncWaitResult> {
  // Headless `gD9`+`UD9` race lives in `waitForFirstSkillsSyncWithTimeout`
  // (official print.ts call site cannot be edited in this hop). Keep both
  // reachable from the live SkillTool import.
  void getSkillsSyncWaitTimeoutMs
  void waitForFirstSkillsSyncWithTimeout
  const pending = pendingWaits.get(name)
  return pending ? pending.promise : Promise.resolve({ ok: true })
}

/** Official 2.1.149 `Pr7`. */
function registerSyncedSkill(command: Command): void {
  syncedSkills.set(command.name, command)
}

/** Official 2.1.149 `Wr7`. */
function unregisterSyncedSkill(name: string): void {
  syncedSkills.delete(name)
}

/** Official 2.1.149 `Zr7`. Identity check against the synced-skill registry. */
export function isSyncedRemoteSkill(command: { name: string }): boolean {
  return syncedSkills.get(command.name) === command
}

/** Official 2.1.149 `Gr7`. */
function pruneStaleSyncedSkills(liveNames: Set<string>): number {
  let removed = 0
  for (const name of syncedSkills.keys()) {
    if (!liveNames.has(name)) {
      syncedSkills.delete(name)
      removed++
    }
  }
  for (const name of pendingWaits.keys()) {
    if (!liveNames.has(name)) pendingWaits.delete(name)
  }
  return removed
}

/**
 * Official 2.1.149 `Tr7`. Returns placeholder + still-registered remote skills.
 * Starts `QD9` so the list-skills engine is live on the command-list path
 * (official `FNA` call site cannot be edited in this hop).
 */
export function getSyncedRemoteSkills(): Command[] {
  if (isSkillsSyncEnabled()) startSkillsSyncInterval()
  return syncedSkills.size === 0 ? [] : Array.from(syncedSkills.values())
}

/** Official 2.1.149 `q7q`. */
function getFirstSyncWait(): { promise: Promise<void>; resolve: () => void } {
  if (!firstSyncWait) {
    let resolve!: () => void
    firstSyncWait = {
      promise: new Promise<void>(r => {
        resolve = r
      }),
      resolve,
    }
  }
  return firstSyncWait
}

/**
 * Official 2.1.149 `QD9`. Kick the first sync and start the 10-minute interval.
 */
export function startSkillsSyncInterval(): void {
  firstSyncKickoff ??= runSkillsSyncDeduped()
  if (!syncInterval) {
    syncInterval = setInterval(() => void runSkillsSyncDeduped(), SYNC_INTERVAL_MS)
    syncInterval.unref?.()
  }
}

/** Official 2.1.149 `gD9`. */
export function waitForFirstSkillsSync(): Promise<void> {
  const wait = getFirstSyncWait()
  firstSyncKickoff ??= runSkillsSyncDeduped()
  return wait.promise
}

/**
 * Official 2.1.149 print.ts race: `UD9` vs `gD9`, then
 * `tengu_skills_sync_wait_timeout` + `A7q` on timeout.
 */
export async function waitForFirstSkillsSyncWithTimeout(
  startedAt = performance.now(),
): Promise<void> {
  const remaining =
    getSkillsSyncWaitTimeoutMs() - (performance.now() - startedAt)
  const timeout = sleep(Math.max(0, remaining)).then(() => 'timeout' as const)
  if ((await Promise.race([waitForFirstSkillsSync(), timeout])) === 'timeout') {
    logEvent('tengu_skills_sync_wait_timeout', {})
    notifySkillsChanged()
  }
}

/** Official 2.1.149 `A7q`. */
function notifySkillsChanged(): void {
  clearSkillCaches()
  skillsSyncChanged.emit()
}

export const subscribeSkillsSyncChanged = skillsSyncChanged.subscribe

/** Official 2.1.149 `Oy$`. */
function getSyncedSkillsDir(): string {
  return join(getClaudeConfigHomeDir(), 'skills')
}

/** Official 2.1.149 `dD9`. */
function getManifestPath(): string {
  return join(getSyncedSkillsDir(), MANIFEST_FILENAME)
}

/** Official 2.1.149 `K7q`. */
function getStagingDir(): string {
  return join(getSyncedSkillsDir(), '.staging')
}

/** Official 2.1.149 `EB`. */
function getTmpDir(): string {
  return process.env.CLAUDE_CODE_TMPDIR || tmpdir()
}

/** Official 2.1.149 `d8$`. */
function skillDirForName(name: string): string {
  const sanitized = name.replace(/[<>"|?*\\/]/g, '_')
  const root = getSyncedSkillsDir()
  const dest = join(root, sanitized)
  const rel = relative(root, dest)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`invalid skill name: ${name}`)
  }
  return dest
}

/** Official 2.1.149 `ANA`. */
async function readManifest(): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(getManifestPath(), 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** Official 2.1.149 `RO` (tmp + rename). */
async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, contents, { encoding: 'utf8' })
    try {
      await rename(tmp, path)
    } catch {
      await writeFile(path, contents, { encoding: 'utf8' })
      await rm(tmp, { force: true }).catch(() => {})
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Official 2.1.149 `zNA`. */
async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(getSyncedSkillsDir(), { recursive: true })
  await atomicWriteFile(getManifestPath(), jsonStringify(manifest, null, 2))
}

/** Official 2.1.149 `YNA`. */
export function diffSyncedSkills(
  remote: SyncedSkillRecord[],
  local: SyncedSkillRecord[],
): DiffResult {
  const prevById = new Map(local.map(skill => [skill.skillId, skill]))
  const remoteIds = new Set(remote.map(skill => skill.skillId))
  const liveDirs = new Set<string>()
  const toDownload: DiffResult['toDownload'] = []
  const carryover: SyncedSkillRecord[] = []

  for (const skill of remote) {
    const prev = prevById.get(skill.skillId)
    let dir: string
    try {
      dir = skillDirForName(skill.name)
    } catch {
      logForDiagnosticsNoPII('warn', 'skills_sync_invalid_name')
      if (prev) carryover.push(prev)
      continue
    }
    if (liveDirs.has(dir)) {
      logForDiagnosticsNoPII('warn', 'skills_sync_name_collision')
      if (prev) carryover.push(prev)
      continue
    }
    liveDirs.add(dir)
    if (!prev || prev.updatedAt !== skill.updatedAt || prev.name !== skill.name) {
      toDownload.push({ skill, prev })
    } else {
      carryover.push(prev)
    }
  }

  return {
    toDownload,
    toRemove: local.filter(skill => !remoteIds.has(skill.skillId)),
    carryover,
    liveDirs,
  }
}

/** Official 2.1.149 `Zx` (lazy to avoid commands.ts ↔ skillsSync cycle). */
function invalidateCommandCaches(): void {
  void import('../../commands.js').then(
    m => m.clearCommandsCache(),
    () => {},
  )
}

/** Official 2.1.149 `KZ`/`rW`/`r9` after a placeholder download. */
async function findLoadedSkill(name: string): Promise<Command | undefined> {
  const { getCommands, findCommand } = await import('../../commands.js')
  return findCommand(name, await getCommands(getProjectRoot()))
}

/** Official 2.1.149 `fNA`. */
function createPlaceholderSkill(skill: SyncedSkillRecord): Command {
  const dir = skillDirForName(skill.name)
  const name = basename(dir)
  const command = createSkillCommand({
    skillName: name,
    displayName: undefined,
    description: skill.description,
    hasUserSpecifiedDescription: true,
    markdownContent: '',
    allowedTools: [],
    disallowedTools: [],
    argumentHint: undefined,
    argumentNames: [],
    whenToUse: undefined,
    version: undefined,
    model: undefined,
    disableModelInvocation: false,
    userInvocable: true,
    source: 'userSettings',
    baseDir: dir,
    loadedFrom: 'skills',
    hooks: undefined,
    executionContext: undefined,
    agent: undefined,
    paths: undefined,
    effort: undefined,
    shell: undefined,
  })
  if (command.type === 'prompt') {
    command.getPromptForCommand = async (args, context) => {
      const wait = await waitForSyncedSkill(name)
      if (wait.ok) {
        const loaded = await findLoadedSkill(name)
        if (loaded && loaded.type === 'prompt' && loaded !== command) {
          const prompt = command as PromptCommand
          prompt.allowedTools = loaded.allowedTools
          prompt.hooks = loaded.hooks
          prompt.model = loaded.model
          prompt.effort = loaded.effort
          prompt.getEffort = loaded.getEffort
          prompt.source = loaded.source
          prompt.skillRoot = loaded.skillRoot
          prompt.contentLength = loaded.contentLength
          prompt.progressMessage = loaded.progressMessage
          command.userInvocable = loaded.userInvocable
          return loaded.getPromptForCommand(args, context)
        }
      }
      const reason =
        wait.ok === false ? wait.reason : 'skill not found after download'
      return [
        {
          type: 'text',
          text: `Skill ${name} could not be downloaded (${reason}). Proceed without it.`,
        },
      ]
    }
  }
  return command
}

/** Official 2.1.149 `ONA`. */
async function downloadAndExtractSkill(
  skill: SyncedSkillRecord,
): Promise<boolean> {
  const dest = skillDirForName(skill.name)
  const staging = join(getStagingDir(), relative(getSyncedSkillsDir(), dest))
  const zipPath = join(
    getTmpDir(),
    `claude-skill-${process.pid}-${Math.random().toString(36).slice(2)}.zip`,
  )
  try {
    if (!(await downloadSkillZip(skill.skillId, zipPath))) return false
    await rm(staging, { recursive: true, force: true })
    await mkdir(getStagingDir(), { recursive: true })
    await extractZipToDirectory(zipPath, staging)
    let extracted = staging
    const entries = await readdir(staging, { withFileTypes: true })
    if (
      !entries.some(entry => entry.name === 'SKILL.md') &&
      entries.length === 1 &&
      entries[0]!.isDirectory()
    ) {
      extracted = join(staging, entries[0]!.name)
    }
    await rm(dest, { recursive: true, force: true })
    await rename(extracted, dest)
    return true
  } finally {
    await rm(zipPath, { force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** Official 2.1.149 `pD9`. */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next++
        if (index >= items.length) return
        await fn(items[index]!)
      }
    },
  )
  await Promise.all(workers)
}

/** Official 2.1.149 `_7q`. */
function runSkillsSyncDeduped(): Promise<void> {
  if (inFlightSync) return inFlightSync
  inFlightSync = runSkillsSync().finally(() => {
    inFlightSync = null
  })
  return inFlightSync
}

/** Official 2.1.149 `MNA`. */
async function runSkillsSync(): Promise<void> {
  const started = Date.now()
  const pendingResolves = new Map<string, (result: SyncWaitResult) => void>()
  try {
    logForDiagnosticsNoPII('info', 'skills_sync_starting')
    const listed = await listRemoteSkills()
    if (!listed.success) {
      logForDiagnosticsNoPII('warn', 'skills_sync_list_failed', {
        duration_ms: Date.now() - started,
      })
      logEvent('tengu_skills_sync_list_failed', {
        duration_ms: Date.now() - started,
      })
      return
    }

    const manifest = await readManifest()
    const { toDownload, toRemove, carryover, liveDirs } = diffSyncedSkills(
      listed.skills,
      manifest?.skills ?? [],
    )

    const removeDir = async (name: string): Promise<void> => {
      try {
        const dir = skillDirForName(name)
        if (liveDirs.has(dir)) return
        await rm(dir, { recursive: true, force: true })
      } catch {
        // official swallows remove errors
      }
    }

    await rm(getStagingDir(), { recursive: true, force: true }).catch(() => {})

    const liveNames = new Set(Array.from(liveDirs, dir => basename(dir)))
    if (pruneStaleSyncedSkills(liveNames) > 0) {
      invalidateCommandCaches()
      skillsSyncChanged.emit()
    }

    if (toDownload.length === 0 && toRemove.length === 0) {
      logForDiagnosticsNoPII('info', 'skills_sync_no_changes', {
        duration_ms: Date.now() - started,
      })
      return
    }

    let placeholders = 0
    for (const { skill, prev } of toDownload) {
      if (!prev) {
        registerSyncedSkill(createPlaceholderSkill(skill))
        placeholders++
        pendingResolves.set(
          skill.skillId,
          registerPendingWait(basename(skillDirForName(skill.name))),
        )
      }
    }
    if (placeholders > 0) {
      invalidateCommandCaches()
      skillsSyncChanged.emit()
    }
    getFirstSyncWait().resolve()

    const downloaded: SyncedSkillRecord[] = []
    const failedPrev: SyncedSkillRecord[] = []
    await mapPool(toDownload, DOWNLOAD_CONCURRENCY, async ({ skill, prev }) => {
      let ok = false
      try {
        ok = await downloadAndExtractSkill(skill)
      } catch {
        logForDiagnosticsNoPII('warn', 'skills_sync_extract_failed')
      }
      if (ok) {
        downloaded.push(skill)
        if (prev && prev.name !== skill.name) await removeDir(prev.name)
        unregisterSyncedSkill(basename(skillDirForName(skill.name)))
        clearSkillCaches()
        invalidateCommandCaches()
      } else if (prev) {
        failedPrev.push(prev)
      }
      pendingResolves.get(skill.skillId)?.(
        ok ? { ok: true } : { ok: false, reason: 'download failed' },
      )
    })

    await mapPool(toRemove, DOWNLOAD_CONCURRENCY, skill => removeDir(skill.name))
    notifySkillsChanged()
    await writeManifest({
      lastUpdated: Date.now(),
      skills: [...carryover, ...downloaded, ...failedPrev],
    })
    logForDiagnosticsNoPII('info', 'skills_sync_complete', {
      downloaded: downloaded.length,
      removed: toRemove.length,
      duration_ms: Date.now() - started,
    })
    logEvent('tengu_skills_sync_success', {
      downloaded: downloaded.length,
      removed: toRemove.length,
      total: listed.skills.length,
      duration_ms: Date.now() - started,
    })
  } catch {
    logForDiagnosticsNoPII('error', 'skills_sync_unexpected_error', {
      duration_ms: Date.now() - started,
    })
    logEvent('tengu_skills_sync_error', {
      duration_ms: Date.now() - started,
    })
  } finally {
    for (const resolve of pendingResolves.values()) {
      resolve({ ok: false, reason: 'skills sync failed' })
    }
    getFirstSyncWait().resolve()
  }
}
