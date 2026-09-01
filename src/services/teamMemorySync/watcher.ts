/**
 * Team Memory File Watcher
 *
 * Watches the team memory directory for changes and triggers
 * a debounced push to the server when files are modified.
 * Performs an initial pull on startup, then starts a directory-level
 * fs.watch so first-time writes to a fresh repo get picked up.
 */

import { feature } from 'bun:bundle'
import { type FSWatcher, watch } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import {
  getTeamMemPath,
  isTeamMemoryEnabled,
} from '../../memdir/teamMemPaths.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { parseClaudeMemoryStores } from './memoryStores.js'
import { getGithubRepo } from '../../utils/git.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  createSyncState,
  isTeamMemorySyncAvailable,
  pullTeamMemory,
  pushTeamMemory,
  type SyncState,
} from './index.js'
import {
  createMultiStoreState,
  flushMultiStorePush,
  runMultiStoreSync,
  type MultiStoreState,
} from './multiStoreSync.js'
import type { TeamMemorySyncPushResult } from './types.js'

const DEBOUNCE_MS = 2000 // Wait 2s after last change before pushing

// ─── Watcher state ──────────────────────────────────────────
let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pushInProgress = false
let hasPendingChanges = false
let currentPushPromise: Promise<void> | null = null
let watcherStarted = false

// Set after a push fails for a reason that can't self-heal on retry.
// Prevents watch events from other sessions' writes to the shared team
// dir driving an infinite retry loop (BQ Mar 14-16: one no_oauth device
// emitted 167K push events over 2.5 days). Cleared on unlink — file deletion
// is a recovery action for the too-many-entries case, and for no_oauth the
// suppression persisting until session restart is correct.
let pushSuppressedReason: string | null = null

/**
 * Permanent = retry without user action will fail the same way.
 * - no_oauth / no_repo: pre-request client checks, no status code
 * - 4xx except 409/429: client error (404 missing repo, 413 too many
 *   entries, 403 permission). 409 is a transient conflict — server state
 *   changed under us, a fresh push after next pull can succeed. 429 is a
 *   rate limit — watcher-driven backoff is fine.
 */
export function isPermanentFailure(r: TeamMemorySyncPushResult): boolean {
  if (r.errorType === 'no_oauth' || r.errorType === 'no_repo') return true
  if (
    r.httpStatus !== undefined &&
    r.httpStatus >= 400 &&
    r.httpStatus < 500 &&
    r.httpStatus !== 409 &&
    r.httpStatus !== 429
  ) {
    return true
  }
  return false
}

// Sync state owned by the watcher — shared across all sync operations.
let syncState: SyncState | null = null

// Multi-store sync state (Official 2.1.143 `a9H`). Mutually exclusive with
// `syncState`: exactly one is set after startTeamMemoryWatcher. The multi-store
// path owns its own per-mount backends/state in multiStoreSync.ts.
let multiStoreState: MultiStoreState | null = null

/**
 * Execute the push and track its lifecycle.
 * Push is read-only on disk (delta+probe, no merge writes), so no event
 * suppression is needed — edits arriving mid-push hit schedulePush() and
 * the debounce re-arms after this push completes.
 */
async function executePush(): Promise<void> {
  // Official 2.1.143 `Zz5` — multi-store path: run the full pull+push
  // aggregator across all mounts, clear pending on a clean run, and promote
  // any *new* permanent failure to per-mount suppression (whole-session
  // suppression once every mount is permanently down).
  if (multiStoreState) {
    pushInProgress = true
    try {
      const stores = multiStoreState.stores
      const alreadySuppressed = new Set(
        stores
          .filter(store => store.suppressedReason !== null)
          .map(store => store.mountName),
      )
      const result = await runMultiStoreSync(multiStoreState)
      if (!Object.values(result.pushes).some(push => !push.success)) {
        hasPendingChanges = false
      }
      for (const store of stores) {
        if (
          store.suppressedReason !== null &&
          !alreadySuppressed.has(store.mountName)
        ) {
          logEvent('tengu_team_mem_push_suppressed', {
            reason:
              store.suppressedReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            multistore: true,
            mount:
              store.mountName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
        }
      }
      if (
        stores.length > 0 &&
        stores.every(store => store.suppressedReason !== null)
      ) {
        const reason = stores[0]!.suppressedReason
        if (reason !== null && pushSuppressedReason === null) {
          pushSuppressedReason = reason
          logForDebugging(
            `team-memory-watcher: suppressing retry for the rest of this session (${reason}) (all ${stores.length} mounts suppressed)`,
            { level: 'warn' },
          )
          logEvent('tengu_team_mem_push_suppressed', {
            reason:
              reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            multistore: true,
            stores: stores.length,
          })
        }
      }
    } catch (e) {
      logForDebugging(
        `team-memory-watcher: multi-store sync error: ${errorMessage(e)}`,
        { level: 'warn' },
      )
    } finally {
      pushInProgress = false
      currentPushPromise = null
    }
    return
  }

  if (!syncState) {
    return
  }
  pushInProgress = true
  try {
    const result = await pushTeamMemory(syncState)
    if (result.success) {
      hasPendingChanges = false
    }
    if (result.success && result.filesUploaded > 0) {
      logForDebugging(
        `team-memory-watcher: pushed ${result.filesUploaded} files`,
        { level: 'info' },
      )
    } else if (!result.success) {
      logForDebugging(`team-memory-watcher: push failed: ${result.error}`, {
        level: 'warn',
      })
      if (isPermanentFailure(result) && pushSuppressedReason === null) {
        pushSuppressedReason =
          result.httpStatus !== undefined
            ? `http_${result.httpStatus}`
            : (result.errorType ?? 'unknown')
        logForDebugging(
          `team-memory-watcher: suppressing retry until next unlink or session restart (${pushSuppressedReason})`,
          { level: 'warn' },
        )
        logEvent('tengu_team_mem_push_suppressed', {
          reason:
            pushSuppressedReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...(result.httpStatus && { status: result.httpStatus }),
        })
      }
    }
  } catch (e) {
    logForDebugging(`team-memory-watcher: push error: ${errorMessage(e)}`, {
      level: 'warn',
    })
  } finally {
    pushInProgress = false
    currentPushPromise = null
  }
}

/**
 * Debounced push: waits for writes to settle, then pushes once.
 */
function schedulePush(): void {
  if (pushSuppressedReason !== null) return
  hasPendingChanges = true
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    if (pushInProgress) {
      schedulePush()
      return
    }
    currentPushPromise = executePush()
  }, DEBOUNCE_MS)
}

/**
 * Start watching the team memory directory for changes.
 *
 * Uses `fs.watch({recursive: true})` on the directory (not chokidar).
 * chokidar 4+ dropped fsevents, and Bun's `fs.watch` fallback uses kqueue,
 * which requires one open fd per watched file — with 500+ team memory files
 * that's 500+ permanently-held fds (confirmed via lsof + repro).
 *
 * `recursive: true` is required because team memory supports subdirs
 * (validateTeamMemKey, pushTeamMemory's walkDir). On macOS Bun uses
 * FSEvents for recursive — O(1) fds regardless of tree size (verified:
 * 2 fds for 60 files across 5 subdirs). On Linux inotify needs one watch
 * per directory — O(subdirs), still fine (team memory rarely nests).
 *
 * `fs.watch` on a directory doesn't distinguish add/change/unlink — all three
 * emit `rename`. To clear suppression on the too-many-entries recovery path
 * (user deletes files), we stat the filename on each event: ENOENT → treat as
 * unlink.  For `no_oauth` suppression this is correct: no_oauth users don't
 * delete team memory files to recover, they restart with auth.
 */
async function startFileWatcher(teamDir: string): Promise<void> {
  if (watcherStarted) {
    return
  }
  watcherStarted = true

  try {
    // pullTeamMemory returns early without creating the dir for fresh repos
    // with no server content (index.ts isEmpty path). mkdir with
    // recursive:true is idempotent — no existence check needed.
    await mkdir(teamDir, { recursive: true })

    watcher = watch(
      teamDir,
      { persistent: true, recursive: true },
      (_eventType, filename) => {
        if (filename === null) {
          schedulePush()
          return
        }
        if (pushSuppressedReason !== null) {
          // Suppression is only cleared by unlink (recovery action for
          // too-many-entries). fs.watch doesn't distinguish unlink from
          // add/write — stat to disambiguate. ENOENT → file gone → clear.
          void stat(join(teamDir, filename)).catch(
            (err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') return
              if (pushSuppressedReason !== null) {
                logForDebugging(
                  `team-memory-watcher: unlink cleared suppression (was: ${pushSuppressedReason})`,
                  { level: 'info' },
                )
                pushSuppressedReason = null
              }
              schedulePush()
            },
          )
          return
        }
        schedulePush()
      },
    )
    watcher.on('error', err => {
      logForDebugging(
        `team-memory-watcher: fs.watch error: ${errorMessage(err)}`,
        { level: 'warn' },
      )
    })
    logForDebugging(`team-memory-watcher: watching ${teamDir}`, {
      level: 'debug',
    })
  } catch (err) {
    // fs.watch throws synchronously on ENOENT (race: dir deleted between
    // mkdir and watch) or EACCES. watcherStarted is already true above,
    // so notifyTeamMemoryWrite's explicit schedulePush path still works.
    logForDebugging(
      `team-memory-watcher: failed to watch ${teamDir}: ${errorMessage(err)}`,
      { level: 'warn' },
    )
  }

  registerCleanup(async () => stopTeamMemoryWatcher())
}

/**
 * Start the team memory sync system.
 *
 * Returns early (before creating any state) if:
 *   - TEAMMEM build flag is off
 *   - team memory is disabled (isTeamMemoryEnabled)
 *   - OAuth is not available (isTeamMemorySyncAvailable)
 *   - the current repo has no github.com remote
 *
 * The early github.com check prevents a noisy failure mode where the
 * watcher starts, it fires on local edits, and every push/pull
 * logs `errorType: no_repo` forever. Team memory is GitHub-scoped on
 * the server side, so non-github.com remotes can never sync anyway.
 *
 * Pulls from server, then starts the file watcher unconditionally.
 * The watcher must start even when the server has no content yet
 * (fresh EAP repo) — otherwise Claude's first team-memory write
 * depends entirely on PostToolUse hooks firing notifyTeamMemoryWrite,
 * which is a chicken-and-egg: Claude's write rate is low enough that
 * a fresh partner can sit in the bootstrap dead zone for days.
 */
export async function startTeamMemoryWatcher(): Promise<void> {
  if (!feature('TEAMMEM')) {
    return
  }
  if (!isTeamMemoryEnabled() || !isTeamMemorySyncAvailable()) {
    return
  }

  // Official 2.1.143 `Gz5`/`V64`: multi-store env is parsed before the
  // github.com-remote check. Invalid JSON disables sync. A valid non-empty
  // list is the multi-store path (full pull/push aggregator is later hop).
  let memoryStores: ReturnType<typeof parseClaudeMemoryStores>
  try {
    memoryStores = parseClaudeMemoryStores()
  } catch (err) {
    logForDebugging(
      `team-memory-watcher: CLAUDE_MEMORY_STORES invalid, disabling sync: ${errorMessage(err)}`,
      { level: 'error' },
    )
    logEvent('tengu_team_mem_multistore_config_invalid', {
      error: errorMessage(err) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return
  }
  // Official 2.1.143 `Gz5` multi-store path: build per-mount state, run the
  // initial pull+push aggregator once (best-effort — a failure here is logged
  // but not fatal), then start the file watcher so subsequent local edits
  // trigger a re-sync. The watcher watches the base team dir recursively,
  // which covers every mount (they live under `<teamMemPath>/<mount>`).
  if (memoryStores !== null) {
    multiStoreState = createMultiStoreState(memoryStores)
    try {
      await runMultiStoreSync(multiStoreState)
    } catch (err) {
      logForDebugging(
        `team-memory-watcher: multi-store initial sync failed: ${errorMessage(err)}`,
        { level: 'warn' },
      )
    }
    await startFileWatcher(getTeamMemPath())
    logEvent('tengu_feature_ok', {
      feature_name:
        'team_memory_sync_watcher_start' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logEvent('tengu_team_mem_sync_started', {
      multistore: true,
      stores: memoryStores.length,
      watcher_started: true,
    })
    return
  }

  const repoSlug = await getGithubRepo()
  if (!repoSlug) {
    logForDebugging(
      'team-memory-watcher: no github.com remote, skipping sync',
      { level: 'debug' },
    )
    return
  }

  syncState = createSyncState()

  // Initial pull from server (runs before the watcher starts, so its disk
  // writes won't trigger schedulePush)
  let initialPullSuccess = false
  let initialFilesPulled = 0
  let serverHasContent = false
  try {
    const pullResult = await pullTeamMemory(syncState)
    initialPullSuccess = pullResult.success
    serverHasContent = pullResult.entryCount > 0
    if (pullResult.success && pullResult.filesWritten > 0) {
      initialFilesPulled = pullResult.filesWritten
      logForDebugging(
        `team-memory-watcher: initial pull got ${pullResult.filesWritten} files`,
        { level: 'info' },
      )
    }
  } catch (e) {
    logForDebugging(
      `team-memory-watcher: initial pull failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
  }

  // Always start the watcher. Watching an empty dir is cheap,
  // and the alternative (lazy start on notifyTeamMemoryWrite) creates
  // a bootstrap dead zone for fresh repos.
  await startFileWatcher(getTeamMemPath())

  logEvent('tengu_team_mem_sync_started', {
    initial_pull_success: initialPullSuccess,
    initial_files_pulled: initialFilesPulled,
    // Kept for dashboard continuity; now always true when this event fires.
    watcher_started: true,
    server_has_content: serverHasContent,
  })
}

/**
 * Call this when a team memory file is written (e.g. from PostToolUse hooks).
 * Schedules a push explicitly in case fs.watch misses the write —
 * a file written in the same tick the watcher starts may not fire an
 * event, and some platforms coalesce rapid successive writes.
 * If the watcher does fire, the debounce timer just resets.
 */
export async function notifyTeamMemoryWrite(): Promise<void> {
  // Official 2.1.143 `Tz5` — either the single-store or multi-store state
  // being present enables the write → debounced sync path.
  if (!syncState && !multiStoreState) {
    return
  }
  schedulePush()
}

/**
 * Stop the file watcher and flush pending changes.
 * Note: runs within the 2s graceful shutdown budget, so the flush
 * is best-effort — if the HTTP PUT doesn't complete in time,
 * process.exit() will kill it.
 */
export async function stopTeamMemoryWatcher(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
  }
  // Await any in-flight push
  if (currentPushPromise) {
    try {
      await currentPushPromise
    } catch {
      // Ignore errors during shutdown
    }
  }
  // Flush pending changes that were debounced but not yet pushed
  if (hasPendingChanges && pushSuppressedReason === null) {
    try {
      if (multiStoreState) {
        // Official 2.1.143 `c64` — best-effort push-only (no pull) across all
        // non-suppressed mounts.
        await flushMultiStorePush(multiStoreState)
      } else if (syncState) {
        await pushTeamMemory(syncState)
      }
    } catch {
      // Best-effort — shutdown may kill this
    }
  }
}

/**
 * Test-only: reset module state and optionally seed syncState.
 * The feature('TEAMMEM') gate at the top of startTeamMemoryWatcher() is
 * always false in bun test, so tests can't set syncState through the normal
 * path. This helper lets tests drive notifyTeamMemoryWrite() /
 * stopTeamMemoryWatcher() directly.
 *
 * `skipWatcher: true` marks the watcher as already-started without actually
 * starting it. Tests that only exercise the schedulePush/flush path don't
 * need a real watcher.
 */
export function _resetWatcherStateForTesting(opts?: {
  syncState?: SyncState
  multiStoreState?: MultiStoreState
  skipWatcher?: boolean
  pushSuppressedReason?: string | null
}): void {
  watcher = null
  debounceTimer = null
  pushInProgress = false
  hasPendingChanges = false
  currentPushPromise = null
  watcherStarted = opts?.skipWatcher ?? false
  pushSuppressedReason = opts?.pushSuppressedReason ?? null
  syncState = opts?.syncState ?? null
  multiStoreState = opts?.multiStoreState ?? null
}

/**
 * Test-only: start the real fs.watch on a specified directory.
 * Used by the fd-count regression test — startTeamMemoryWatcher() is gated
 * by feature('TEAMMEM') which is false under bun test.
 */
export function _startFileWatcherForTesting(dir: string): Promise<void> {
  return startFileWatcher(dir)
}
