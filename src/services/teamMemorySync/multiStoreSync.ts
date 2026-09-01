/**
 * Team Memory Multi-Store Sync (Official 2.1.143, `tengu_team_mem_multistore_sync`)
 *
 * Adds the multi-store team-memory sync aggregator that was missing from the
 * 143 tree. When `CLAUDE_MEMORY_STORES` is set (see memoryStores.ts), team
 * memory is backed by one or more *memory backends* instead of the single
 * repo-scoped team-memory store. Each backend is mounted at
 * `<teamMemPath>/<mountName>` and is synced concurrently:
 *
 *   - Pull (`Jz5`): list the backend, diff server vs. disk, download changed
 *     entries, delete tombstoned ones.
 *   - Push (`YR6`): diff disk vs. server, upsert changed entries, delete
 *     locally-removed ones (soft-delete via server tombstone).
 *   - Aggregate (`fR6`): run pull+push over every mount concurrently, roll up
 *     per-mount results into one `tengu_team_mem_multistore_sync` event, and
 *     flip a mount into permanent-suppression on a permanent failure.
 *
 * This module is the faithful port of the 143 bundle's multi-store functions
 * (`W64` backend, `Jz5` pull, `YR6` push, `fR6` aggregator, plus their disk
 * walk / path / hash / concurrency helpers and the memory-backend error
 * classes). It does NOT touch the single-store sync path in index.ts — that
 * stays as-is when no memory stores are configured.
 */

import axios from 'axios'
import { createHash } from 'crypto'
import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { z } from 'zod/v4'

import {
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_PROFILE_SCOPE,
  getOauthConfig,
  OAUTH_BETA_HEADER,
} from '../../constants/oauth.js'
import {
  getTeamMemPath,
  PathTraversalError,
  validateTeamMemKey,
} from '../../memdir/teamMemPaths.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { scanForSecrets } from './secretScanner.js'
import type { MemoryStoreEntry } from './memoryStores.js'

// ─── Bundle constants (F64/x64 module scope) ─────────────────
// `HR6` 30s per-request timeout, `fz5` 100KB per-file size cap,
// `AR6` 6 concurrent operations, `gA5` the backend collection path,
// `QA5`/`J64` list page size / max pages.
const MEMORY_REQUEST_TIMEOUT_MS = 30_000
const MEMORY_MAX_FILE_SIZE_BYTES = 102_400
const MEMORY_CONCURRENCY = 6
const MEMORY_COLLECTION_PATH = '/memories'
const MEMORY_LIST_PAGE_SIZE = 100
const MEMORY_MAX_LIST_PAGES = 50

// `Mz5` — the file extensions the disk walk picks up.
const MEMORY_SYNCED_EXTENSIONS = ['.md', '.txt', '.json', '.jsonl']

// ─── Memory-backend error classes ─────────────────────────────
// Bundle `Bb`/`KjH`/`xNH`/`r9H` (the path-traversal error reuses the tree's
// existing `PathTraversalError`, which is the bundle's `SP`).

/** `Bb` — a permanent, non-retryable failure with a machine-readable reason. */
export class PermanentError extends Error {
  readonly reason: string
  constructor(reason: string, message?: string) {
    super(message ?? `permanent: ${reason}`)
    this.name = 'PermanentError'
    this.reason = reason
  }
}

/** `KjH` — a resource is gone (404). */
export class NotFoundError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`not found: ${path}`)
    this.name = 'NotFoundError'
    this.path = path
  }
}

/** `xNH` — a transient unavailability (429/5xx / no-auth / cursor expired). */
export class UnavailableError extends Error {
  readonly cause?: string
  constructor(message: string, cause?: string) {
    super(message)
    this.name = 'UnavailableError'
    this.cause = cause
  }
}

/** `r9H` — an optimistic-locking conflict (409). */
export class ConflictError extends Error {
  readonly path: string
  readonly expected: string | null
  readonly actual: string | null
  /** On create-409: the id of the existing entry that already holds `path`. */
  readonly existingId: string | null
  constructor(
    path: string,
    expected: string | null,
    actual: string | null,
    existingId: string | null = null,
  ) {
    super(
      `conflict on ${path}: expected ${expected ?? '<none>'}, actual ${actual ?? '<unknown>'}`,
    )
    this.name = 'ConflictError'
    this.path = path
    this.expected = expected
    this.actual = actual
    this.existingId = existingId
  }
}

// ─── Auth / HTTP (first-party, mirrors the bundle's `k9`/`oM$`) ──
// The memory backends live under the first-party API base and are OAuth
// scoped to user:inference + user:profile (the same gate the single-store
// sync uses). `no-auth` is surfaced as PermanentError('no_oauth') so a
// not-logged-in device suppresses rather than retry-spamming.

type AuthHeaders =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: 'no-auth'; detail: string }
  | { ok: false; reason: 'essential-traffic-only' | 'data-residency' }

async function getMemoryAuthHeaders(): Promise<AuthHeaders> {
  // `oM$` refuses all non-essential traffic and any non-first-party provider.
  if (isEssentialTrafficOnly()) {
    return { ok: false, reason: 'essential-traffic-only' }
  }
  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) {
    return { ok: false, reason: 'data-residency' }
  }
  try {
    await checkAndRefreshOAuthTokenIfNeeded()
  } catch {
    // proceed with cached token (bundle logs + continues on refresh failure)
  }
  const tokens = getClaudeAIOAuthTokens()
  if (
    tokens?.accessToken &&
    tokens.scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE) &&
    tokens.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)
  ) {
    return {
      ok: true,
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': getClaudeCodeUserAgent(),
      },
    }
  }
  return { ok: false, reason: 'no-auth', detail: 'No OAuth token in keychain' }
}

/**
 * First-party memory API request. Returns a normalized
 * `{ status, data }` so callers mirror the bundle's
 * `validateStatus: () => true` + manual status handling.
 */
async function memoryRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const base = process.env.TEAM_MEMORY_SYNC_URL || getOauthConfig().BASE_API_URL
  const auth = await getMemoryAuthHeaders()
  if (!auth.ok) {
    if (auth.reason === 'no-auth') {
      throw new PermanentError('no_oauth', auth.detail)
    }
    // essential-traffic-only / data-residency: refuse without a network call.
    throw new UnavailableError(`memory-api: ${auth.reason}`)
  }
  const response = await axios.request({
    method,
    url: base + path,
    data: body,
    headers: { 'Content-Type': 'application/json', ...auth.headers },
    timeout: MEMORY_REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'json',
  })
  return { status: response.status, data: response.data }
}

/**
 * Bundle `wW$` — map a non-2xx status to a typed error. 429/5xx are transient
 * (UnavailableError); other 4xx are permanent with an `http_<status>` reason.
 */
function mapHttpError(status: number, label: string, data: unknown): never {
  if (status === 429 || status >= 500) {
    throw new UnavailableError(`${label}: HTTP ${status}`)
  }
  const message =
    data && typeof data === 'object' && 'message' in data
      ? ` (${String((data as { message: unknown }).message)})`
      : ''
  throw new PermanentError(`http_${status}`, `${label}: HTTP ${status}${message}`)
}

// ─── Response schemas (bundle G64 module scope) ───────────────
// `P64`/`aS6`/`dA5`/`cA5`/`X64`/`lA5`.

const memoryIdSchema = lazySchema(() =>
  z.string().regex(/^mem_[A-Za-z0-9]+$/),
)

// A single memory entry (id + path + content hash + optional size).
const memoryEntrySchema = lazySchema(() =>
  z.looseObject({
    id: memoryIdSchema(),
    path: z.string(),
    content_sha256: z.string(),
    content_size_bytes: z.number().int().nonnegative().optional(),
  }),
)

// `dA5` — a paged list envelope.
const memoryListSchema = lazySchema(() =>
  z.looseObject({
    data: z.array(z.looseObject({ type: z.string() })),
    next_page: z.string().nullish(),
  }),
)

// `cA5` — a full entry (id + path + hash + content).
const memoryReadSchema = lazySchema(() =>
  memoryEntrySchema().extend({ content: z.string() }),
)

// `X64` — a create/update ack (id + hash).
const memoryAckSchema = lazySchema(() =>
  z.looseObject({
    id: memoryIdSchema(),
    content_sha256: z.string(),
  }),
)

// `lA5` — a 409 create-conflict body carrying the existing entry's id.
const memoryConflictSchema = lazySchema(() =>
  z.looseObject({
    error: z
      .looseObject({
        type: z.string().optional(),
        conflicting_path: z.string().optional(),
        conflicting_memory_id: memoryIdSchema().optional(),
      })
      .optional(),
  }),
)

/** Bundle `oS6` — normalize a backend path to a single-slash absolute form. */
function normalizeMemoryPath(path: string): string {
  return (path.startsWith('/') ? path : `/${path}`).replace(/\/{2,}/g, '/')
}

/** Bundle `L64` — build a `?a=b&c=d` query string from an object. */
function toQueryString(params: Record<string, string | number>): string {
  const parts = Object.entries(params).map(
    ([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
  )
  return parts.length ? `?${parts.join('&')}` : ''
}

// ─── Backend (`W64`) ──────────────────────────────────────────
// One backend per configured store. `mode` is 'rw' or 'ro'; `listBase` is the
// store's absolute path + '/memories'.

export type MemoryBackend = {
  readonly mode: 'rw' | 'ro'
  readonly label: string
  list(): Promise<
    Array<{ id: string; path: string; sha256: string; sizeBytes: number }>
  >
  read(id: string): Promise<{ content: string; sha256: string }>
  create(
    path: string,
    content: string,
  ): Promise<{ id: string; sha256: string }>
  update(
    id: string,
    content: string,
    preconditionSha256: string | null,
  ): Promise<{ id: string; sha256: string }>
  delete(id: string, expectedSha256: string | null): Promise<void>
}

/** Bundle `Z64` — build a backend per parsed store entry. */
export function createMemoryBackends(
  stores: MemoryStoreEntry[],
): MemoryBackend[] {
  return stores.map(store => new MemoryServiceBackend(store))
}

class MemoryServiceBackend {
  readonly mode: 'rw' | 'ro'
  readonly label: string
  readonly listBase: string

  constructor(store: MemoryStoreEntry) {
    this.mode = store.mode
    this.label = store.mount
    this.listBase = store.path.replace(/\/+$/, '') + MEMORY_COLLECTION_PATH
  }

  private entryPath(path: string): string {
    return `${this.listBase}/${encodeURIComponent(path)}`
  }

  private assertWritable(operation: string): void {
    if (this.mode === 'ro') {
      throw new Error(
        `MemoryServiceBackend[${this.label}]: ${operation} refused on read-only mount`,
      )
    }
  }

  async list(): Promise<
    Array<{ id: string; path: string; sha256: string; sizeBytes: number }>
  > {
    const entries: Array<{
      id: string
      path: string
      sha256: string
      sizeBytes: number
    }> = []
    let page: string | undefined
    for (let pageIndex = 0; ; pageIndex++) {
      if (pageIndex >= MEMORY_MAX_LIST_PAGES) {
        throw new PermanentError(
          'list_page_limit',
          `list ${this.label}: exceeded ${MEMORY_MAX_LIST_PAGES} pages (stuck next_page cursor?)`,
        )
      }
      const query: Record<string, string | number> = {
        limit: MEMORY_LIST_PAGE_SIZE,
      }
      if (page) query.page = page
      const response = await memoryRequest(
        'GET',
        `${this.listBase}${toQueryString(query)}`,
      )
      if (response.status === 404) {
        if (page === undefined) {
          logForDebugging(
            `memory-backend[${this.label}]: list 404 (store not provisioned) — treating as empty`,
            { level: 'debug' },
          )
          return []
        }
        throw new UnavailableError(
          `list ${this.label}: 404 on page ${pageIndex} (cursor expired or store deleted mid-walk)`,
        )
      }
      if (response.status >= 400) {
        mapHttpError(response.status, `list ${this.label}`, response.data)
      }
      const parsed = memoryListSchema().safeParse(response.data)
      if (!parsed.success) {
        throw new PermanentError(
          'malformed_response',
          `list ${this.label}: malformed response: ${parsed.error.message}`,
        )
      }
      for (const item of parsed.data.data) {
        if (item.type !== 'memory') continue
        const entry = memoryEntrySchema().safeParse(item)
        if (!entry.success) {
          throw new PermanentError(
            'malformed_response',
            `list ${this.label}: malformed memory item: ${entry.error.message}`,
          )
        }
        entries.push({
          id: entry.data.id,
          path: normalizeMemoryPath(entry.data.path),
          sha256: entry.data.content_sha256,
          sizeBytes: entry.data.content_size_bytes ?? 0,
        })
      }
      page = parsed.data.next_page ?? undefined
      if (!page) break
    }
    return entries
  }

  async read(id: string): Promise<{ content: string; sha256: string }> {
    const label = `read ${this.label}:${id}`
    const response = await memoryRequest('GET', this.entryPath(id))
    if (response.status === 404) throw new NotFoundError(id)
    if (response.status >= 400) {
      mapHttpError(response.status, label, response.data)
    }
    const parsed = memoryReadSchema().safeParse(response.data)
    if (!parsed.success) {
      throw new PermanentError(
        'malformed_response',
        `${label}: malformed response: ${parsed.error.message}`,
      )
    }
    return {
      content: parsed.data.content,
      sha256: parsed.data.content_sha256,
    }
  }

  async create(
    path: string,
    content: string,
  ): Promise<{ id: string; sha256: string }> {
    this.assertWritable('create')
    const normalizedPath = normalizeMemoryPath(path)
    const label = `create ${this.label}:${normalizedPath}`
    const response = await memoryRequest('POST', this.listBase, {
      path: normalizedPath,
      content,
    })
    if (response.status === 409) {
      const parsed = memoryConflictSchema().safeParse(response.data)
      const error = parsed.success ? parsed.data.error : undefined
      const existingId =
        error?.conflicting_memory_id &&
        error.conflicting_path !== undefined &&
        normalizeMemoryPath(error.conflicting_path) === normalizedPath
          ? error.conflicting_memory_id
          : null
      throw new ConflictError(normalizedPath, null, null, existingId)
    }
    if (response.status >= 400) {
      mapHttpError(response.status, label, response.data)
    }
    const ack = memoryAckSchema().safeParse(response.data)
    if (!ack.success) {
      throw new PermanentError(
        'malformed_response',
        `${label}: malformed response: ${ack.error.message}`,
      )
    }
    return { id: ack.data.id, sha256: ack.data.content_sha256 }
  }

  async update(
    id: string,
    content: string,
    preconditionSha256: string | null,
  ): Promise<{ id: string; sha256: string }> {
    this.assertWritable('update')
    const label = `update ${this.label}:${id}`
    const body: Record<string, unknown> = { content }
    if (preconditionSha256 !== null) {
      body.precondition = {
        type: 'content_sha256',
        content_sha256: preconditionSha256,
      }
    }
    const response = await memoryRequest('POST', this.entryPath(id), body)
    if (response.status === 404) throw new NotFoundError(id)
    if (response.status === 409) {
      throw new ConflictError(id, preconditionSha256, null)
    }
    if (response.status >= 400) {
      mapHttpError(response.status, label, response.data)
    }
    const ack = memoryAckSchema().safeParse(response.data)
    if (!ack.success) {
      throw new PermanentError(
        'malformed_response',
        `${label}: malformed response: ${ack.error.message}`,
      )
    }
    return { id: ack.data.id, sha256: ack.data.content_sha256 }
  }

  async delete(id: string, expectedSha256: string | null): Promise<void> {
    this.assertWritable('delete')
    const label = `delete ${this.label}:${id}`
    const query: Record<string, string> = {}
    if (expectedSha256 !== null) {
      query.expected_content_sha256 = expectedSha256
    }
    const response = await memoryRequest(
      'DELETE',
      `${this.entryPath(id)}${toQueryString(query)}`,
    )
    if (response.status === 404) {
      // Deleting something already gone is a no-op unless we sent a
      // precondition (in which case the precondition no longer matches).
      if (expectedSha256 !== null) throw new NotFoundError(id)
      return
    }
    if (response.status === 409) {
      throw new ConflictError(id, expectedSha256, null)
    }
    if (response.status >= 400) {
      mapHttpError(response.status, label, response.data)
    }
  }
}

// ─── Disk walk / path / hash helpers ──────────────────────────
// Bundle `Oz5`/`B64`/`wz5`/`p64`/`U64`/`Dz5`/`jz5`/`zR6`.

/** Bundle `Oz5` — bare sha256 hex (no `sha256:` prefix; the backend's
 *  content_sha256 format). */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Bundle `B64` — is this basename a synced memory file? */
function isSyncedMemoryFile(name: string): boolean {
  if (name.startsWith('.')) return false
  return MEMORY_SYNCED_EXTENSIONS.some(ext => name.endsWith(ext))
}

/** Bundle `wz5` — basename of a `/`-separated path. */
function memoryBasename(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  return lastSlash === -1 ? path : path.slice(lastSlash + 1)
}

type MemoryDiskScan = {
  /** path (relative, `/`-separated, leading `/`) → { content, sha256 }. */
  entries: Map<string, { content: string; sha256: string }>
  /** every path seen on disk (relative, `/`-separated). */
  diskPaths: Set<string>
  /** false if any dir was unreadable (EACCES/EPERM) → deletion is unsafe. */
  diskTrusted: boolean
  /** paths skipped because they contain a detected secret. */
  skippedSecretPaths: string[]
}

/**
 * Bundle `p64` — walk a mount dir, hashing + secret-scanning each synced file.
 * Files over `MEMORY_MAX_FILE_SIZE_BYTES` are skipped; files with a secret are
 * collected in `skippedSecretPaths`. A missing dir yields an empty, untrusted
 * scan; EACCES/EPERM mark the dir untrusted (deletions then suppressed).
 */
async function scanMountDir(mountDir: string): Promise<MemoryDiskScan> {
  const entries = new Map<string, { content: string; sha256: string }>()
  const diskPaths = new Set<string>()
  const skippedSecretPaths: string[] = []
  let diskTrusted = true

  async function walk(dir: string): Promise<void> {
    let dirents: Awaited<ReturnType<typeof readdir>>
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      const code = getErrnoCode(err)
      if (code === 'ENOENT') return
      if (code === 'EACCES' || code === 'EPERM') {
        diskTrusted = false
        return
      }
      throw err
    }
    await Promise.all(
      dirents.map(async entry => {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
          return
        }
        if (!entry.isFile() || !isSyncedMemoryFile(entry.name)) return
        const relPath = `/${join(relative(mountDir, fullPath).split(sep).join('/'))}`
        diskPaths.add(relPath)
        try {
          const stats = await stat(fullPath)
          if (stats.size > MEMORY_MAX_FILE_SIZE_BYTES) {
            logForDebugging(
              `multi-store-sync: skipping oversized ${relPath} (${stats.size}B)`,
              { level: 'info' },
            )
            return
          }
          const content = await readFile(fullPath, 'utf8')
          if (scanForSecrets(content).length > 0) {
            skippedSecretPaths.push(relPath)
            logForDebugging(
              `multi-store-sync: skipping ${relPath} (secret detected)`,
              { level: 'warn' },
            )
            return
          }
          entries.set(relPath, { content, sha256: sha256Hex(content) })
        } catch (err) {
          const code = getErrnoCode(err)
          if (code === 'ENOENT') return
          if (code === 'EACCES' || code === 'EPERM') {
            diskTrusted = false
            return
          }
          throw err
        }
      }),
    )
  }

  await walk(mountDir)
  return { entries, diskPaths, diskTrusted, skippedSecretPaths }
}

/**
 * Bundle `U64` — resolve a server path to a contained on-disk path. Joins
 * `<teamMemPath>/<mountName>/<path>`, then delegates to the tree's
 * validateTeamMemKey (the bundle's `WBH`: joins under the team dir, validates
 * the key, and verifies symlink containment). A resulting path that escapes
 * the mount throws PathTraversalError.
 */
async function resolveMemoryDiskPath(
  mountName: string,
  mountDir: string,
  serverPath: string,
): Promise<string> {
  const relativeKey = `${mountName}/${serverPath.replace(/^\/+/, '')}`
  const resolved = await validateTeamMemKey(relativeKey)
  if (!resolved.normalize('NFC').startsWith(mountDir)) {
    throw new PathTraversalError(
      `path escapes mount ${mountName}: ${serverPath}`,
    )
  }
  return resolved
}

/** Bundle `Dz5` — write a pulled entry to disk (creating parent dirs). */
async function writeMemoryEntry(
  store: { mountName: string; mountDir: string },
  serverPath: string,
  content: string,
): Promise<void> {
  const target = await resolveMemoryDiskPath(
    store.mountName,
    store.mountDir,
    serverPath,
  )
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

/** Bundle `jz5` — delete a locally-tombstoned entry (ENOENT is a no-op). */
async function deleteMemoryEntry(
  store: { mountName: string; mountDir: string },
  serverPath: string,
): Promise<void> {
  try {
    const target = await resolveMemoryDiskPath(
      store.mountName,
      store.mountDir,
      serverPath,
    )
    await unlink(target)
  } catch (err) {
    if (err instanceof PathTraversalError) {
      logForDebugging(
        `multi-store-sync[${store.mountName}]: refusing to delete escaping path ${serverPath}`,
        { level: 'warn' },
      )
      return
    }
    if (getErrnoCode(err) === 'ENOENT') return
    throw err
  }
}

/**
 * Bundle `zR6` — run `worker` over `items` with bounded concurrency.
 * Items are dispatched in order to `concurrency` workers.
 */
async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++]
        await worker(item)
      }
    },
  )
  await Promise.all(workers)
}

// ─── Per-mount state ──────────────────────────────────────────
// Bundle `m64` build block: `{ backend, mountName, mountDir, remoteHashes,
// pulled, suppressedReason }`.

export type MultiStoreMount = {
  backend: MemoryBackend
  mountName: string
  mountDir: string
  /** server path → { id, sha256 } last known from the backend. */
  remoteHashes: Map<string, { id: string; sha256: string }>
  /** true after a successful pull this run (gates push soft-delete). */
  pulled: boolean
  /** set on a permanent failure; further sync for this mount is skipped. */
  suppressedReason: string | null
}

export type MultiStoreState = {
  stores: MultiStoreMount[]
}

/** Bundle `m64` — create per-mount state from parsed store entries. */
export function createMultiStoreState(
  stores: MemoryStoreEntry[],
): MultiStoreState {
  const backends = createMemoryBackends(stores)
  if (backends.length !== stores.length) {
    throw new Error('createMultiStoreState: length mismatch')
  }
  const base = getTeamMemPath()
  const storesState = stores.map((store, index) => {
    const mountName = store.mount
    return {
      backend: backends[index]!,
      mountName,
      mountDir: (join(base, mountName) + sep).normalize('NFC'),
      remoteHashes: new Map<string, { id: string; sha256: string }>(),
      pulled: false,
      suppressedReason: null,
    }
  })
  return { stores: storesState }
}

// ─── Pull (`Jz5`) ─────────────────────────────────────────────

type MultiStorePullResult = {
  success: boolean
  entriesListed: number
  filesWritten: number
  filesDeleted: number
  permanent?: string
  error?: string
}

/**
 * Bundle `Jz5` — pull one mount: list the backend, download entries whose
 * hash differs from both disk and the previous remote state, and delete
 * entries that vanished from the server (only when the disk is trusted).
 * Updates `store.remoteHashes` on success.
 */
async function pullStore(store: MultiStoreMount): Promise<MultiStorePullResult> {
  let remoteEntries
  try {
    remoteEntries = await store.backend.list()
  } catch (err) {
    return {
      success: false,
      entriesListed: 0,
      filesWritten: 0,
      filesDeleted: 0,
      permanent: err instanceof PermanentError ? err.reason : undefined,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  // Keep only synced-extension entries (defensive: backend may list others).
  const entries = remoteEntries.filter(entry =>
    isSyncedMemoryFile(memoryBasename(entry.path)),
  )
  const remoteHashes = new Map<string, { id: string; sha256: string }>()
  for (const entry of entries) {
    remoteHashes.set(entry.path, { id: entry.id, sha256: entry.sha256 })
  }

  const disk = await scanMountDir(store.mountDir)
  // Download: server entries whose hash differs from disk AND from the
  // previous remote state (avoid re-downloading unchanged content).
  const toDownload = entries.filter(
    entry =>
      disk.entries.get(entry.path)?.sha256 !== entry.sha256 &&
      store.remoteHashes.get(entry.path)?.sha256 !== entry.sha256,
  )
  // Delete: server entries no longer present, only if disk is trusted and we
  // previously knew them as remote (so we never delete on a first pull).
  const toDelete = disk.diskTrusted
    ? [...disk.diskPaths].filter(
        path => !remoteHashes.has(path) && store.remoteHashes.has(path),
      )
    : []

  let filesWritten = 0
  let filesDeleted = 0
  let permanent: string | undefined
  let error: string | undefined

  await runConcurrent(toDownload, MEMORY_CONCURRENCY, async entry => {
    try {
      const read = await store.backend.read(entry.id)
      await writeMemoryEntry(store, entry.path, read.content)
      filesWritten++
    } catch (err) {
      if (err instanceof NotFoundError) {
        remoteHashes.delete(entry.path)
        return
      }
      if (err instanceof PathTraversalError) {
        logForDebugging(
          `multi-store-sync[${store.mountName}]: refusing to write escaping path ${entry.path}`,
          { level: 'warn' },
        )
        remoteHashes.delete(entry.path)
        return
      }
      if (err instanceof PermanentError) permanent ??= err.reason
      error ??= err instanceof Error ? err.message : String(err)
    }
  })
  for (const path of toDelete) {
    try {
      await deleteMemoryEntry(store, path)
      filesDeleted++
    } catch (err) {
      error ??= err instanceof Error ? err.message : String(err)
    }
  }

  if (error) {
    return {
      success: false,
      entriesListed: entries.length,
      filesWritten,
      filesDeleted,
      permanent,
      error,
    }
  }
  store.remoteHashes = remoteHashes
  store.pulled = true
  return {
    success: true,
    entriesListed: entries.length,
    filesWritten,
    filesDeleted,
  }
}

// ─── Push (`YR6`) ─────────────────────────────────────────────

type MultiStorePushResult = {
  success: boolean
  filesWritten: number
  filesDeleted: number
  conflicts: number
  secretsSkipped: number
  permanent?: string
  error?: string
}

/** `YR6` success default (bundle `$D8`). */
const PUSH_SUCCESS_DEFAULT: MultiStorePushResult = {
  success: true,
  filesWritten: 0,
  filesDeleted: 0,
  conflicts: 0,
  secretsSkipped: 0,
}

/**
 * Bundle `YR6` — push one mount: diff disk vs. remote, upsert changed entries,
 * soft-delete locally-removed entries (only after a successful pull). Returns
 * the per-mount aggregate (conflicts counted, secrets skipped).
 */
async function pushStore(store: MultiStoreMount): Promise<MultiStorePushResult> {
  if (store.backend.mode === 'ro') return PUSH_SUCCESS_DEFAULT
  if (!store.pulled) return PUSH_SUCCESS_DEFAULT

  const disk = await scanMountDir(store.mountDir)
  const toUpsert: Array<{
    path: string
    content: string
    known: { id: string; sha256: string } | null
  }> = []
  for (const [path, entry] of disk.entries) {
    const known = store.remoteHashes.get(path)
    if (known?.sha256 === entry.sha256) continue
    toUpsert.push({ path, content: entry.content, known })
  }
  const toDelete: Array<{
    path: string
    ref: { id: string; sha256: string }
  }> = []
  if (disk.diskTrusted) {
    for (const [path, ref] of store.remoteHashes) {
      if (!disk.diskPaths.has(path)) toDelete.push({ path, ref })
    }
  }

  let filesWritten = 0
  let filesDeleted = 0
  let conflicts = 0
  let permanent: string | undefined
  let error: string | undefined

  const recordError = (err: unknown): void => {
    if (err instanceof PermanentError) {
      permanent ??= err.reason
      error ??= err.message
      return
    }
    if (err instanceof UnavailableError) {
      error ??= err.message
      return
    }
    error ??= err instanceof Error ? err.message : String(err)
  }

  await runConcurrent(toUpsert, MEMORY_CONCURRENCY, async item => {
    try {
      let ack: { id: string; sha256: string }
      if (item.known) {
        ack = await store.backend.update(
          item.known.id,
          item.content,
          item.known.sha256,
        )
      } else {
        try {
          ack = await store.backend.create(item.path, item.content)
        } catch (createErr) {
          // A create-409 with a known existing id means the entry was created
          // under us (e.g. by a concurrent pull) — update it instead.
          if (createErr instanceof ConflictError && createErr.existingId) {
            ack = await store.backend.update(
              createErr.existingId,
              item.content,
              null,
            )
          } else {
            throw createErr
          }
        }
      }
      store.remoteHashes.set(item.path, ack)
      filesWritten++
    } catch (err) {
      if (err instanceof ConflictError) {
        if (err.actual && item.known) {
          store.remoteHashes.set(item.path, {
            id: item.known.id,
            sha256: err.actual,
          })
        }
        conflicts++
        return
      }
      recordError(err)
    }
  })
  await runConcurrent(toDelete, MEMORY_CONCURRENCY, async item => {
    try {
      await store.backend.delete(item.ref.id, item.ref.sha256)
      store.remoteHashes.delete(item.path)
      filesDeleted++
    } catch (err) {
      if (err instanceof ConflictError) {
        if (err.actual) {
          store.remoteHashes.set(item.path, {
            id: item.ref.id,
            sha256: err.actual,
          })
        }
        conflicts++
        return
      }
      if (err instanceof NotFoundError) {
        store.remoteHashes.delete(item.path)
        return
      }
      recordError(err)
    }
  })

  return {
    success: !error,
    filesWritten,
    filesDeleted,
    conflicts,
    secretsSkipped: disk.skippedSecretPaths.length,
    permanent,
    error,
  }
}

// ─── Aggregator (`fR6`) ───────────────────────────────────────

export type MultiStoreSyncResult = {
  pulls: Record<string, MultiStorePullResult>
  pushes: Record<string, MultiStorePushResult>
}

/** `fR6` suppressed-pull default (bundle `Xz5`). */
const SUPPRESSED_PULL_RESULT: MultiStorePullResult = {
  success: true,
  entriesListed: 0,
  filesWritten: 0,
  filesDeleted: 0,
}

/**
 * Bundle `fR6` — the multi-store sync aggregator. For every configured mount,
 * runs a pull (skipping suppressed mounts) concurrently, then a push
 * concurrently, then rolls the per-mount results up into a single
 * `tengu_team_mem_multistore_sync` event (+ `tengu_feature_ok`/`_bad` spans).
 * A permanent pull/push failure flips that mount's `suppressedReason` so the
 * watcher stops retrying it.
 */
export async function runMultiStoreSync(
  state: MultiStoreState,
): Promise<MultiStoreSyncResult> {
  const pulls: Record<string, MultiStorePullResult> = {}
  const pushes: Record<string, MultiStorePushResult> = {}

  // Concurrent pull across mounts. Suppressed mounts are skipped (recorded as
  // a no-op success so the roll-up still counts them).
  await Promise.all(
    state.stores.map(async store => {
      if (store.suppressedReason !== null) {
        pulls[store.mountName] = SUPPRESSED_PULL_RESULT
        return
      }
      try {
        await mkdir(store.mountDir, { recursive: true })
        pulls[store.mountName] = await pullStore(store)
      } catch (err) {
        pulls[store.mountName] = {
          success: false,
          entriesListed: 0,
          filesWritten: 0,
          filesDeleted: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  // Concurrent push across mounts (after all pulls settle).
  await Promise.all(
    state.stores.map(async store => {
      if (store.suppressedReason !== null) {
        pushes[store.mountName] = {
          ...PUSH_SUCCESS_DEFAULT,
          success: false,
          error: 'suppressed',
        }
        return
      }
      try {
        pushes[store.mountName] = await pushStore(store)
      } catch (err) {
        pushes[store.mountName] = {
          ...PUSH_SUCCESS_DEFAULT,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  // Promote permanent failures to per-mount suppression.
  for (const store of state.stores) {
    if (store.suppressedReason !== null) continue
    const permanent =
      pulls[store.mountName]?.permanent ??
      pushes[store.mountName]?.permanent
    if (permanent) {
      store.suppressedReason = permanent
      logForDebugging(
        `multi-store-sync[${store.mountName}]: suppressing further sync (${permanent})`,
        { level: 'warn' },
      )
    }
  }

  // Roll up the aggregate stats (bundle `K`).
  const pullValues = Object.values(pulls)
  const pushValues = Object.values(pushes)
  const stats = {
    stores: state.stores.length,
    stores_suppressed: state.stores.filter(
      store => store.suppressedReason !== null,
    ).length,
    pull_written: pullValues.reduce((sum, r) => sum + r.filesWritten, 0),
    pull_deleted: pullValues.reduce((sum, r) => sum + r.filesDeleted, 0),
    push_written: pushValues.reduce((sum, r) => sum + r.filesWritten, 0),
    push_deleted: pushValues.reduce((sum, r) => sum + r.filesDeleted, 0),
    conflicts: pushValues.reduce((sum, r) => sum + r.conflicts, 0),
    secrets_skipped: pushValues.reduce(
      (sum, r) => sum + r.secretsSkipped,
      0,
    ),
    pull_failures: pullValues.filter(r => !r.success).length,
    push_failures: pushValues.filter(r => !r.success).length,
  }

  // Telemetry — the aggregate event + the feature ok/bad spans (bundle `d` /
  // `IH` / `mH`).
  logEvent(
    'tengu_team_mem_multistore_sync',
    {
      stores: stats.stores,
      stores_suppressed: stats.stores_suppressed,
      pull_written: stats.pull_written,
      pull_deleted: stats.pull_deleted,
      push_written: stats.push_written,
      push_deleted: stats.push_deleted,
      conflicts: stats.conflicts,
      secrets_skipped: stats.secrets_skipped,
      pull_failures: stats.pull_failures,
      push_failures: stats.push_failures,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  )
  if (stats.pull_failures === 0) {
    logEvent('tengu_feature_ok', {
      feature_name:
        'team_memory_multistore_pull' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  } else {
    logEvent('tengu_feature_bad', {
      feature_name:
        'team_memory_multistore_pull' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_code:
        'multistore_pull_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
  if (stats.push_failures === 0) {
    logEvent('tengu_feature_ok', {
      feature_name:
        'team_memory_multistore_push' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  } else {
    logEvent('tengu_feature_bad', {
      feature_name:
        'team_memory_multistore_push' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_code:
        'multistore_push_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  logForDebugging(
    `multi-store-sync: ${stats.stores} store(s) — ` +
      `pull ↓${stats.pull_written}/−${stats.pull_deleted}, ` +
      `push ↑${stats.push_written}/−${stats.push_deleted}` +
      (stats.conflicts ? `, ${stats.conflicts} conflict(s)` : '') +
      (stats.pull_failures || stats.push_failures
        ? `, failures pull=${stats.pull_failures} push=${stats.push_failures}`
        : ''),
    { level: 'info' },
  )

  return { pulls, pushes }
}

/**
 * Bundle `c64` flush — best-effort push-only (no pull) across all
 * non-suppressed mounts. Used at graceful shutdown to flush pending local
 * edits. Returns the per-mount push results.
 */
export async function flushMultiStorePush(
  state: MultiStoreState,
): Promise<Record<string, MultiStorePushResult>> {
  const pushes: Record<string, MultiStorePushResult> = {}
  await Promise.all(
    state.stores
      .filter(store => store.suppressedReason === null)
      .map(async store => {
        try {
          pushes[store.mountName] = await pushStore(store)
        } catch (err) {
          pushes[store.mountName] = {
            ...PUSH_SUCCESS_DEFAULT,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
  )
  return pushes
}
