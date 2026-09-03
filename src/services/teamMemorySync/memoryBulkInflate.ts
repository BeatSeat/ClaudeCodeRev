/**
 * Team Memory — multi-store-sync "bulk inflate" fast-path (2.1.161 G10).
 *
 * Official 2.1.161 `kKA` (single-arg `kKA(H)`, the minifier reused the 160
 * `kKA` query-timing name — see the 2.1.161 hop review, minifier name-reuse
 * caveat) plus its NDJSON inflate parser `yk4` / line splitter `ZKA` /
 * `LineTooLongError` `bk8`. This is the 161-added delta of the team-memory
 * multi-store-sync subsystem.
 *
 * What this fast-path does: when pulling a mounted memory store, instead of the
 * per-file pull (list → read each changed entry one at a time), call
 * `backend.exportAll()` to stream the ENTIRE store in one NDJSON export and
 * inflate it in a single pass. On any failure (export unavailable, parse
 * failure, count mismatch, dedupe unlink failure) it falls back so the caller
 * runs the per-file pull.
 *
 * Gate / kill-switch (verbatim, 161):
 *   - `tengu_memory_bulk_inflate` GrowthBook gate, default ON (`!0`).
 *   - `CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE` env kill-switch (bundle parses
 *     it as a boolean via the `pH.bool()` registry getter).
 *   - Skipped (returns "not-attempted") when the store was already pulled this
 *     session, when remote hashes are already populated, or when the backend
 *     has no `exportAll`.
 *
 * ── BOUNDARY (rule-10 G10) ──────────────────────────────────────────────────
 * Ported here, verbatim from 2.1.161 (all 0→N, firstSeen 161):
 *   - the gate `tengu_memory_bulk_inflate` (default ON) + the
 *     `CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE` kill-switch,
 *   - the fast-path `tryBulkInflate` (bundle `kKA`),
 *   - the NDJSON inflate pipeline: `parseMemoryExportStream` (`yk4`),
 *     `splitNdjsonLines` (`ZKA`), `LineTooLongError` (`bk8`), and the
 *     loose-object schemas `LKA`/`PKA`/`WKA`.
 *
 * 未覆盖 — the surrounding multi-store-sync subsystem is the deferred 2.1.143
 * G22 gap (`team_mem_multistore_sync`, `vKA`/`Bk4`/`bk4`/`Ia6`/`ba6`, backend
 * implementations, the per-file pull aggregator, and the `mountName`/
 * `remoteHashes`/`backend`/`pulled` mount state the orchestrator `vKA` owns).
 * The mount file I/O this fast-path writes through — `uk4`/`mk4`/`xk4`/`AD$`
 * (160=1, part of G22, not the 161 delta) — is ported here as self-contained
 * mount-scoped helpers so the 161 fast-path is complete and type-checkable
 * against the existing single-store tree, rather than importing G22 symbols
 * that do not exist in this tree. These helpers are NOT part of the 161
 * G10 delta; they are the G22 seam the fast-path depends on. The per-file
 * fallback itself (orchestrator `vKA` + `Bk4` + `bk4` + `Ia6`) is NOT
 * ported — it is G22 and is reached by the caller on "fell-back".
 *
 * Bundle → tree symbol map (minified short name → readable name):
 *   kKA  → tryBulkInflate            yk4  → parseMemoryExportStream
 *   ZKA  → splitNdjsonLines          bk8  → LineTooLongError
 *   J$   → getFeatureValue_CACHED_MAY_BE_STALE
 *   L8.CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE
 *          → process.env.CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE (+ isEnvTruthy)
 *   SH   → featureOk (tengu_feature_ok)      e$ → featureSad (tengu_feature_sad)
 *   N    → logForDebugging           TH   → errorMessage
 *   vKH  → MemoryStoreEntryNotFoundError     bj → PathTraversalError (teamMemPaths)
 *   VE$/Ca6/Ck4 → normalizeExportPath / isMemoryLineFilename / basename
 *   xk4/uk4/mk4 → resolveMountPath / writeMemoryFile / removeMemoryFile
 *   x5   → withStallTimeout          e8   → count
 *   Ik4  → createMultiStoreMount (state factory the orchestrator vKA owns)
 *   LKA/PKA/WKA → memoryLineDiscriminator / memoryLineSchema / completeLineSchema
 *   xk8  → BULK_INFLATE_CONCURRENT_WRITES    GKA → INFLATE_MAX_LINE_LENGTH
 *   Ek4  → DEFAULT_INFLATE_STALL_TIMEOUT_MS  VKA → INFLATE_ALLOWED_EXTENSIONS
 *
 * Not ported here (bundle names, 未覆盖 G22): Kb (PermissionDenied, `reason`
 * field) — only referenced by the G22 per-file fallback; `iwH` canonicity check;
 * the real stream-backed backend `exportAll` implementation.
 */

import { mkdir, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { StringDecoder } from 'string_decoder'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { PathTraversalError } from '../../memdir/teamMemPaths.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { count } from '../../utils/array.js'
import { lazySchema } from '../../utils/lazySchema.js'

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Error thrown by `backend.exportAll()` (and `read`) when the store has no
 * remote content (HTTP 404). Official 2.1.161 `vKH` (`name="NotFoundError"`,
 * `super('not found: ' + label)`, `.path` field).
 */
export class MemoryStoreEntryNotFoundError extends Error {
  path: string
  constructor(path: string) {
    super(`not found: ${path}`)
    this.name = 'NotFoundError'
    this.path = path
  }
}

/**
 * Result of one `backend.exportAll()` call: the NDJSON export stream plus a
 * cleanup hook. Official 2.1.161: `return {stream: q, destroy: () => _k4(q)}`.
 */
export type ExportStream = {
  /** NDJSON byte/string stream of the exported store. */
  stream: AsyncIterable<string | Uint8Array>
  /** Abort/close the export stream (used in `finally`). */
  destroy(): void
}

/**
 * Minimal memory-store backend interface the bulk-inflate fast-path needs.
 * The full backend (per-file `list`/`read`, secret scanning, push, `exportAll`
 * HTTP implementation) is the deferred 2.1.143 G22 subsystem — only the
 * 161-added `exportAll` is required here, so it is optional: a backend
 * without it makes the fast-path return "not-attempted" (per-file pull).
 */
export interface MemoryStoreBackend {
  /** Store label used in `not found`/error messages (G22). */
  readonly label?: string
  /**
   * 161 G10: stream the entire store as NDJSON. Absent → fast-path skipped.
   */
  exportAll?: () => Promise<ExportStream>
}

/** Per-entry remote hash ref: `{ id, sha256 }` (bundle `_.set(...)` value). */
export type RemoteHashRef = { id: string; sha256: string }

/**
 * Per-mount mutable sync state. Official 2.1.161 `Ik4` state factory
 * (`createMultiStoreState`) builds one of these per mount. The fast-path reads
 * and mutates it. The orchestrator that owns this (`vKA`) is G22 (未覆盖).
 */
export interface MultiStoreMount {
  /** Mounted store backend (G22; only `exportAll`/`label` used here). */
  backend: MemoryStoreBackend
  /** Human-readable mount name — appears in every `multi-store-sync[...]` log. */
  mountName: string
  /**
   * Absolute, NFC-normalized, trailing-sep-terminated dir the mount is
   * contained in. Written paths must stay inside it (bundle `mountDir`).
   */
  mountDir: string
  /** `relativePath → { id, sha256 }` for the current remote content. */
  remoteHashes: Map<string, RemoteHashRef>
  /** True after a successful pull this session. */
  pulled: boolean
}

/**
 * Outcome of the bulk-inflate fast-path attempt. Official 2.1.161 `kKA`
 * returns the two status strings or a success object:
 *   - `not-attempted` — gate/env/backend/state preconditions not met; the
 *     caller runs the normal per-file pull (G22) without any fallback signal.
 *   - `fell-back` — `exportAll` was attempted but failed; the caller runs the
 *     per-file pull and marks failures as `fallback_failed` (G22).
 *   - `success` — the whole store was inflated; the caller skips per-file.
 */
export type BulkInflateAttempt =
  | { status: 'not-attempted' }
  | { status: 'fell-back' }
  | {
      status: 'success'
      entriesListed: number
      filesWritten: number
      filesDeleted: number
    }

/**
 * One `memory` NDJSON line after decoding (bundle `yk4` `L` object:
 * `{path, content, contentSha256, memoryId}`).
 */
export type MemoryLine = {
  path: string
  content: string
  contentSha256: string
  memoryId: string
}

/**
 * Result of `parseMemoryExportStream`. `ok: false` carries a machine-readable
 * `reason` used for the `tengu_feature_sad` error_code. Bundle `yk4` reasons:
 * parse_failed / write_failed / oversized_line / stream_error /
 * stream_truncated / count_mismatch / decrypt_errors.
 */
export type InflateResult =
  | { ok: true; memoryLines: number }
  | { ok: false; reason: string }

// ─── Schemas (bundle LKA / PKA / WKA, `y.looseObject`) ────────────────────

/**
 * `LKA = NH(() => y.looseObject({type: y.string()}))` — the discriminator
 * pre-parse that every line must satisfy before the `type` switch.
 */
const memoryLineDiscriminator = lazySchema(() =>
  z.looseObject({ type: z.string() }),
)

/**
 * `PKA = NH(() => y.looseObject({type: y.literal("memory"), path, content,
 * content_sha256, memory_id: y.string()}))`.
 */
const memoryLineSchema = lazySchema(() =>
  z.looseObject({
    type: z.literal('memory'),
    path: z.string(),
    content: z.string(),
    content_sha256: z.string(),
    memory_id: z.string(),
  }),
)

/**
 * `WKA = NH(() => y.looseObject({type: y.literal("complete"),
 * memory_count: y.number().int().nonnegative(),
 * error_count: y.number().int().nonnegative().optional()}))`.
 */
const completeLineSchema = lazySchema(() =>
  z.looseObject({
    type: z.literal('complete'),
    memory_count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative().optional(),
  }),
)

// ─── Constants (bundle module-level) ───────────────────────────────────────

/** `xk8 = 6` — max concurrent handleMemory writes during inflate. */
const BULK_INFLATE_CONCURRENT_WRITES = 6

/** `Ek4 = 60000` — default per-chunk stall timeout for the export stream (ms). */
const DEFAULT_INFLATE_STALL_TIMEOUT_MS = 60_000

/**
 * `GKA = Rk4 * 6 + 16384` with `Rk4 = 102400` → 630784. Max bytes per NDJSON
 * line before `LineTooLongError`.
 */
const INFLATE_MAX_LINE_LENGTH = 102400 * 6 + 16384

/**
 * `VKA = [".md", ".txt", ".json", ".jsonl"]` — the only memory entry file
 * extensions the fast-path will write. (160=1; G22 seam constant.)
 */
const INFLATE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.jsonl']

/** Feature name reported to `tengu_feature_*` events (bundle first arg). */
const BULK_INFLATE_FEATURE = 'team_memory_multistore_bulk_inflate'

// ─── Feature telemetry (bundle SH / e$ / IH) ──────────────────────────────

type FeatureMeta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

/** Bundle `wa8` is identity (`H => H`); the tree brands it with `as Meta`. */
function asFeatureMeta(value: string): FeatureMeta {
  return value as FeatureMeta
}

/** Bundle `SH(name)` → `d("tengu_feature_ok", {feature_name})`. */
function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', { feature_name: asFeatureMeta(featureName) })
}

/** Bundle `e$(name, code)` → `d("tengu_feature_sad", {feature_name, error_code})`. */
function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: asFeatureMeta(featureName),
    error_code: asFeatureMeta(errorCode),
  })
}

// ─── Gate + kill-switch (bundle `L8.CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE`
// + `J$("tengu_memory_bulk_inflate", !0)`) ─────────────────────────────────

/**
 * Whether the bulk-inflate fast-path is enabled. Mirrors the bundle
 * `kKA` preconditions exactly:
 *   `if (L8.CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE) return "not-attempted"`
 *   `if (!J$("tengu_memory_bulk_inflate", !0)) return "not-attempted"`
 * The env kill-switch wins over the (default-ON) gate.
 */
export function isMemoryBulkInflateEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_memory_bulk_inflate', true)
}

// ─── Mount-scoped path + I/O helpers ───────────────────────────────────────
// 未覆盖 G22 seam (bundle 160=1). Ported as self-contained so the 161
// fast-path is complete; the mount state they read is built by
// createMultiStoreMount below (also G22).

/**
 * Bundle `VE$` — normalize an exported memory path to a mount-relative,
 * forward-slashed key: ensure a leading `/`, collapse duplicate slashes.
 */
function normalizeExportPath(path: string): string {
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  return withLeadingSlash.replace(/\/{2,}/g, '/')
}

/** Bundle `Ck4` — last path segment (no separator). */
function basenamePath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/**
 * Bundle `Ca6` — a memory entry is a writable file only if it is not a dotfile
 * and ends with one of `INFLATE_ALLOWED_EXTENSIONS`.
 */
function isMemoryLineFilename(filename: string): boolean {
  if (filename.startsWith('.')) return false
  return INFLATE_ALLOWED_EXTENSIONS.some(ext => filename.endsWith(ext))
}

/**
 * Bundle `xk4` — resolve a mount-relative key to an absolute path, NFC-
 * normalized, rejecting any escape outside `mountDir`. Throws
 * `PathTraversalError` (bundle `bj`) on escape.
 */
async function resolveMountPath(mount: MultiStoreMount, relativeKey: string) {
  // Bundle `xk4`/`AD$`: `join(mountName, key)` then `AD$` prepends the shared
  // team root `Rv()`, so the effective resolved path is `<mountDir><key>` —
  // and `mountDir` already encodes `<teamRoot>/<mountName>/`. Join it directly.
  // (The deep symlink-containment step inside `AD$` is the G22 layer — omitted
  // here; the single-store tree handles it via teamMemPaths' validateTeamMemKey.)
  const resolved = resolve(
    join(mount.mountDir, relativeKey.replace(/^\/+/, '')),
  ).normalize('NFC')
  if (!resolved.startsWith(mount.mountDir)) {
    throw new PathTraversalError(`path escapes mount ${mount.mountName}: ${relativeKey}`)
  }
  return resolved
}

/**
 * Bundle `uk4` — mkdir the parent of a mount-relative key and write its
 * content as UTF-8. (G22 seam; the real `uk4` also resolves the deepest
 * existing ancestor for symlink containment — not reproduced here.)
 */
async function writeMemoryFile(
  mount: MultiStoreMount,
  relativeKey: string,
  content: string,
): Promise<void> {
  const absolute = await resolveMountPath(mount, relativeKey)
  await mkdir(resolve(absolute, '..'), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

/**
 * Bundle `mk4` — remove a previously-written mount-relative key. Swallows
 * ENOENT and path-escape (logs a warn) rather than failing the batch.
 * (G22 seam.)
 */
async function removeMemoryFile(
  mount: MultiStoreMount,
  relativeKey: string,
): Promise<void> {
  try {
    const absolute = await resolveMountPath(mount, relativeKey)
    await rm(absolute)
  } catch (error) {
    if (error instanceof PathTraversalError) {
      logForDebugging(
        `multi-store-sync[${mount.mountName}]: refusing to delete escaping path ${relativeKey}`,
        { level: 'warn' },
      )
      return
    }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    if (code === 'ENOENT') return
    throw error
  }
}

// ─── NDJSON inflate pipeline (bundle ZKA / bk8 / yk4) ─────────────────────

/**
 * Bundle `bk8` (`name="LineTooLongError"`).
 */
class LineTooLongError extends Error {
  constructor(maxBytes: number) {
    super(`NDJSON line exceeds ${maxBytes} bytes`)
    this.name = 'LineTooLongError'
  }
}

/**
 * Bundle `x5` — race a promise against a timeout that rejects with
 * `Error(message)`; the timer is unref'd (no process pinning) and cleared in
 * `finally`.
 */
async function withStallTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stallMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(stallMessage)), timeoutMs)
    if (typeof timer === 'object') timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Bundle `ZKA` — split an async byte/string stream into NDJSON lines.
 * Decodes via `string_decoder` (handles multi-byte chars split across
 * chunks), yields each non-empty line (CRLF → LF), throws
 * `LineTooLongError` when a pending line exceeds `maxLineLength`, and
 * destroys the source + returns the iterator in `finally`.
 */
async function* splitNdjsonLines(
  source: ExportStream,
  maxLineLength: number,
  stallTimeoutMs: number = DEFAULT_INFLATE_STALL_TIMEOUT_MS,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const asyncIterator = source.stream[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await withStallTimeout(
        asyncIterator.next(),
        stallTimeoutMs,
        'export stream stalled',
      )
      if (next.done) break
      const value = next.value
      buffer += typeof value === 'string' ? value : decoder.write(value)
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length > maxLineLength) throw new LineTooLongError(maxLineLength)
        if (line !== '') yield line
      }
      if (buffer.length > maxLineLength) throw new LineTooLongError(maxLineLength)
    }
    buffer += decoder.end()
    if (buffer !== '' && buffer !== '\r') {
      yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    }
  } finally {
    source.destroy()
    asyncIterator.return?.().catch(() => undefined)
  }
}

/**
 * Bundle `yk4` — inflate an `exportAll()` NDJSON stream into memory files via
 * `handleMemory`. Tracks the `complete` line's expected counts, bounds the
 * in-flight writes to `maxConcurrentWrites`, and returns a structured
 * success/failure (with the machine-readable `reason` for telemetry).
 */
async function parseMemoryExportStream(options: {
  source: ExportStream
  handleMemory: (memoryLine: MemoryLine) => Promise<void>
  maxConcurrentWrites: number
  maxLineLength: number
  stallTimeoutMs?: number
}): Promise<InflateResult> {
  const inFlight = new Set<Promise<void>>()
  let firstWriteError: unknown
  let memoryCount = 0
  let memoryErrorCount = 0
  let complete: { memoryCount: number; errorCount: number } | null = null

  async function settleAll(): Promise<void> {
    await Promise.all(inFlight)
  }
  async function fail(reason: string): Promise<InflateResult> {
    await settleAll()
    return { ok: false, reason }
  }

  try {
    for await (const line of splitNdjsonLines(
      options.source,
      options.maxLineLength,
      options.stallTimeoutMs,
    )) {
      if (complete !== null) return await fail('parse_failed')
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return await fail('parse_failed')
      }
      const discriminator = memoryLineDiscriminator().safeParse(raw)
      if (!discriminator.success) return await fail('parse_failed')
      switch (discriminator.data.type) {
        case 'store':
          break
        case 'memory': {
          const memoryLine = memoryLineSchema().safeParse(raw)
          if (!memoryLine.success) return await fail('parse_failed')
          memoryCount++
          while (inFlight.size >= options.maxConcurrentWrites) {
            await Promise.race(inFlight)
          }
          if (firstWriteError !== undefined) return await fail('write_failed')
          const entry: MemoryLine = {
            path: memoryLine.data.path,
            content: memoryLine.data.content,
            contentSha256: memoryLine.data.content_sha256,
            memoryId: memoryLine.data.memory_id,
          }
          const pending = options.handleMemory(entry).catch(error => {
            firstWriteError ??= error
          }).finally(() => {
            inFlight.delete(pending)
          })
          inFlight.add(pending)
          break
        }
        case 'memory_error':
          memoryErrorCount++
          break
        case 'complete': {
          const completeLine = completeLineSchema().safeParse(raw)
          if (!completeLine.success) return await fail('parse_failed')
          complete = {
            memoryCount: completeLine.data.memory_count,
            errorCount: completeLine.data.error_count ?? 0,
          }
          break
        }
        default:
          break
      }
    }
  } catch (error) {
    await settleAll()
    if (error instanceof LineTooLongError) return { ok: false, reason: 'oversized_line' }
    return { ok: false, reason: 'stream_error' }
  }

  await settleAll()
  if (firstWriteError !== undefined) return { ok: false, reason: 'write_failed' }
  if (complete === null) return { ok: false, reason: 'stream_truncated' }
  if (complete.memoryCount !== memoryCount) return { ok: false, reason: 'count_mismatch' }
  if (complete.errorCount > 0 || memoryErrorCount > 0) {
    return { ok: false, reason: 'decrypt_errors' }
  }
  return { ok: true, memoryLines: memoryCount }
}

// ─── Bulk-inflate fast-path (bundle `kKA`) ─────────────────────────────────

/**
 * Official 2.1.161 `kKA` — the multi-store-sync bulk-inflate fast-path.
 * Returns a {@link BulkInflateAttempt}; the (G22, 未覆盖) per-file pull
 * orchestrator `vKA` consumes it: `not-attempted`/`fell-back` → run per-file,
 * `success` → skip.
 *
 * Verbatim gate/kill-switch order from the bundle:
 * ```
 * if (H.pulled || H.remoteHashes.size > 0) return "not-attempted";
 * let $ = H.backend;
 * if (!$.exportAll) return "not-attempted";
 * if (L8.CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE) return "not-attempted";
 * if (!J$("tengu_memory_bulk_inflate", !0)) return "not-attempted";
 * ```
 */
export async function tryBulkInflate(mount: MultiStoreMount): Promise<BulkInflateAttempt> {
  // Precondition: nothing to inflate this session (already pulled, or the
  // caller already populated remote hashes).
  if (mount.pulled || mount.remoteHashes.size > 0) {
    return { status: 'not-attempted' }
  }

  const backend = mount.backend
  // Precondition: backend must support whole-store export.
  if (!backend.exportAll) {
    return { status: 'not-attempted' }
  }

  // Gate + kill-switch (bundle order): env kill-switch first, then the
  // default-ON GrowthBook gate.
  if (!isMemoryBulkInflateEnabled()) {
    return { status: 'not-attempted' }
  }

  const logPrefix = `multi-store-sync[${mount.mountName}]`

  let source: ExportStream
  try {
    source = await backend.exportAll()
  } catch (error) {
    const errorCode =
      error instanceof MemoryStoreEntryNotFoundError ? 'not_found' : 'http_error'
    featureSad(BULK_INFLATE_FEATURE, errorCode)
    logForDebugging(
      `${logPrefix}: bulk inflate unavailable (${errorMessageOf(error)}) — using per-file pull`,
      { level: 'debug' },
    )
    return { status: 'fell-back' }
  }

  // remotePath → { id, sha256 } for entries that survived the inflate.
  const hashesToKeep = new Map<string, RemoteHashRef>()
  // memoryId → normalized export path (null when the entry was not a writable
  // memory file, i.e. a memory_error / non-memory entry).
  const memoryIdToExportedPath = new Map<string, string | null>()

  const inflateResult = await parseMemoryExportStream({
    source,
    maxConcurrentWrites: BULK_INFLATE_CONCURRENT_WRITES,
    maxLineLength: INFLATE_MAX_LINE_LENGTH,
    handleMemory: async memoryLine => {
      const normalizedPath = normalizeExportPath(memoryLine.path)
      const writable = isMemoryLineFilename(basenamePath(normalizedPath))
      memoryIdToExportedPath.set(memoryLine.memoryId, writable ? normalizedPath : null)
      if (!writable) return
      try {
        await writeMemoryFile(mount, normalizedPath, memoryLine.content)
      } catch (error) {
        if (error instanceof PathTraversalError) {
          logForDebugging(
            `${logPrefix}: refusing to write escaping path ${normalizedPath}`,
            { level: 'warn' },
          )
          return
        }
        throw error
      }
      hashesToKeep.set(normalizedPath, {
        id: memoryLine.memoryId,
        sha256: memoryLine.contentSha256,
      })
    },
  })

  // Dedupe: if two export lines map the same memoryId, the one that was NOT
  // written last (per memoryIdToExportedPath) is superseded — delete it and
  // drop it from the hashes. Bundle `for (let [M,w] of _) if (A.get(w.id) !== M)`.
  let unlinkFailed = false
  for (const [relativePath, hashRef] of hashesToKeep) {
    if (memoryIdToExportedPath.get(hashRef.id) !== relativePath) {
      hashesToKeep.delete(relativePath)
      try {
        await removeMemoryFile(mount, relativePath)
      } catch (error) {
        logForDebugging(
          `${logPrefix}: failed to remove superseded ${relativePath} (${errorMessageOf(error)})`,
          { level: 'warn' },
        )
        unlinkFailed = true
      }
    }
  }

  const filesWritten = hashesToKeep.size

  if (!inflateResult.ok || unlinkFailed) {
    const reason = inflateResult.ok ? 'dedupe_unlink_failed' : inflateResult.reason
    featureSad(BULK_INFLATE_FEATURE, reason)
    logForDebugging(
      `${logPrefix}: bulk inflate incomplete (${reason}) after ${filesWritten} file(s) — using per-file pull`,
      { level: 'warn' },
    )
    return { status: 'fell-back' }
  }

  // entriesListed = number of export lines that resolved to a real (non-null)
  // file path (bundle `e8([...A.values()], (M) => M !== null)`).
  const entriesListed = count([...memoryIdToExportedPath.values()], path => path !== null)

  mount.remoteHashes = hashesToKeep
  mount.pulled = true
  featureOk(BULK_INFLATE_FEATURE)
  logForDebugging(
    `${logPrefix}: bulk inflated ${filesWritten} file(s) from ${inflateResult.memoryLines} exported memory line(s)`,
    { level: 'info' },
  )
  return { status: 'success', entriesListed, filesWritten, filesDeleted: 0 }
}

// ─── Local error-message helper (bundle `TH`) ──────────────────────────────

/** Bundle `TH` — `e instanceof Error ? e.message : String(e)`. */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─── Mount state factory (bundle `Ik4`, G22 seam) ──────────────────────────

/**
 * Bundle `Ik4` (`createMultiStoreState`) — build per-mount state for a list of
 * backends + mount names. Ported (G22 seam, 未覆盖) so the fast-path has a
 * concrete `MultiStoreMount` to operate on; the orchestrator `vKA` that
 * consumes these is not ported. The real `Ik4` derives each `mountDir` from
 * the shared team-memory root (`Rv()`) and NFC-normalizes it; the caller here
 * must supply already-resolved `mountDir`s (the G22 aggregator does that).
 */
export function createMultiStoreMount(
  backend: MemoryStoreBackend,
  mountName: string,
  mountDir: string,
): MultiStoreMount {
  return {
    backend,
    mountName,
    mountDir,
    remoteHashes: new Map(),
    pulled: false,
  }
}
