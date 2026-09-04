import { appendFile, mkdir, rename, stat, symlink, unlink } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'

import { type BufferedWriter, createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import {
  type DebugFilter,
  parseDebugFilter,
  shouldShowDebugMessage,
} from './debugFilter.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { writeToStderr } from './process.js'
import { jsonStringify } from './slowOperations.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

/**
 * Minimum log level to include in debug output. Defaults to 'debug', which
 * filters out 'verbose' messages. Set CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose to
 * include high-volume diagnostics (e.g. full statusLine command, shell, cwd,
 * stdout/stderr) that would otherwise drown out useful debug output.
 */
export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  const raw = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
})

let runtimeDebugEnabled = false

export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    // Also check for --debug=pattern syntax
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    // --debug-file implicitly enables debug mode
    getDebugFilePath() !== null
  )
})

/**
 * Enables debug logging mid-session (e.g. via /debug). Non-ants don't write
 * debug logs by default, so this lets them start capturing without restarting
 * with --debug. Returns true if logging was already active.
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode() || process.env.USER_TYPE === 'ant'
  runtimeDebugEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

// Extract and parse debug filter from command line arguments
// Exported for testing purposes
export const getDebugFilter = memoize((): DebugFilter | null => {
  // Look for --debug=pattern in argv
  const debugArg = process.argv.find(arg => arg.startsWith('--debug='))
  if (!debugArg) {
    return null
  }

  // Extract the pattern after the equals sign
  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})

export const isDebugToStdErr = memoize((): boolean => {
  return (
    process.argv.includes('--debug-to-stderr') || process.argv.includes('-d2e')
  )
})

export const getDebugFilePath = memoize((): string | null => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!
    if (arg.startsWith('--debug-file=')) {
      return arg.substring('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < process.argv.length) {
      return process.argv[i + 1]!
    }
  }
  return null
})

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  // Non-ants only write debug logs when debug mode is active (via --debug at
  // startup or /debug mid-session). Ants always log for /share, bug reports.
  if (process.env.USER_TYPE !== 'ant' && !isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  const filter = getDebugFilter()
  return shouldShowDebugMessage(message, filter)
}

let hasFormattedOutput = false
export function setHasFormattedOutput(value: boolean): void {
  hasFormattedOutput = value
}
export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

let debugWriter: BufferedWriter | null = null
let pendingWrite: Promise<void> = Promise.resolve()

// -- Debug-log rotation (official 2.1.166 `pl8`/`pn9`/`AZq` cluster) --------
//
// Rotate the active debug log at 10MB (`Bn9=10485760`) to `<path>.1.txt`
// (paths ending in `.txt`) or `<path>.1`. When the configured debug path is
// itself a directory (e.g. CLAUDE_CODE_DEBUG_LOGS_DIR points at a dir), the
// append fails with EISDIR and we fall back to a per-session file inside it
// (`AZq`). `kpH` tracks written bytes (-1 = unknown, re-stat on next write);
// `_U$` serializes rotations.

const DEBUG_LOG_ROTATE_THRESHOLD_BYTES = 10485760
let rotationByteCount = -1
let isRotatingDebugLog = false
let eisdirFallbackPath: string | null = null

function isENOENTError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

function isEISDIRError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EISDIR'
  )
}

async function maybeRotateDebugLog(
  path: string,
  bytesWritten: number,
  threshold: number = DEBUG_LOG_ROTATE_THRESHOLD_BYTES,
): Promise<void> {
  if (rotationByteCount < 0) {
    rotationByteCount = await stat(path)
      .then(s => s.size)
      .catch(() => 0)
  } else {
    rotationByteCount += bytesWritten
  }
  if (rotationByteCount <= threshold || isRotatingDebugLog) return
  isRotatingDebugLog = true
  try {
    const rotated = path.endsWith('.txt')
      ? `${path.slice(0, -4)}.1.txt`
      : `${path}.1`
    try {
      await rename(path, rotated)
    } catch (err) {
      if (!isENOENTError(err)) {
        await unlink(rotated).catch(() => {})
        await rename(path, rotated).catch(() => unlink(path).catch(() => {}))
      }
    }
    rotationByteCount = 0
  } finally {
    isRotatingDebugLog = false
  }
}

/** Official 2.1.166 `pn9`: reset rotation state. */
export function _resetDebugLogRotationForTesting(): void {
  // Verbatim comma form (`kpH=-1,_U$=!1`) so the bundled token stream matches
  // the official minified declaration.
  rotationByteCount = -1, isRotatingDebugLog = false
}

/** Official `AZq`: per-session fallback file when the debug path is a dir. */
function eisdirFallbackDebugPath(attemptedPath: string): string {
  return (eisdirFallbackPath = join(attemptedPath, `${getSessionId()}.txt`))
}

// Module-level so .bind captures only its explicit args, not the
// writeFn closure's parent scope (Jarred, #22257).
async function appendAsync(
  needMkdir: boolean,
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  if (needMkdir) {
    await mkdir(dir, { recursive: true }).catch(() => {})
  }
  // Official 2.1.166 `Un9`: on EISDIR (debug path is a directory) fall back
  // to a per-session file inside it, then rotate at the size threshold.
  let pathToUse = path
  try {
    await appendFile(path, content)
  } catch (err) {
    if (!isEISDIRError(err)) throw err
    pathToUse = eisdirFallbackDebugPath(path)
    await appendFile(pathToUse, content)
  }
  await maybeRotateDebugLog(pathToUse, Buffer.byteLength(content)).catch(
    noop,
  )
  void updateLatestDebugLogSymlink()
}

function noop(): void {}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          // immediateMode: must stay sync. Async writes are lost on direct
          // process.exit() and keep the event loop alive in beforeExit
          // handlers (infinite loop with Perfetto tracing). See #22257.
          if (needMkdir) {
            try {
              getFsImplementation().mkdirSync(dir)
            } catch {
              // Directory already exists
            }
          }
          // Official 2.1.166 `Fn9` writeFn sync path: same EISDIR fallback +
          // rotation as the async path.
          let pathToUse = path
          try {
            getFsImplementation().appendFileSync(path, content)
          } catch (err) {
            if (!isEISDIRError(err)) throw err
            pathToUse = eisdirFallbackDebugPath(path)
            getFsImplementation().appendFileSync(pathToUse, content)
          }
          void maybeRotateDebugLog(
            pathToUse,
            Buffer.byteLength(content),
          ).catch(noop)
          void updateLatestDebugLogSymlink()
          return
        }
        // Buffered path (ants without --debug): flushes ~1/sec so chain
        // depth stays ~1. .bind over a closure so only the bound args are
        // retained, not this scope.
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingWrite
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = {
    level: 'debug',
  },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return
  }
  if (!shouldLogDebugMessage(message)) {
    return
  }

  // Multiline messages break the jsonl output format, so make any multiline messages JSON.
  if (hasFormattedOutput && message.includes('\n')) {
    message = jsonStringify(message)
  }
  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(output)
    return
  }

  getDebugWriter().write(output)
}

export function getDebugLogPath(): string {
  return (
    getDebugFilePath() ??
    process.env.CLAUDE_CODE_DEBUG_LOGS_DIR ??
    join(getClaudeConfigHomeDir(), 'debug', `${getSessionId()}.txt`)
  )
}

/**
 * Updates the latest debug log symlink to point to the current debug log file.
 * Creates or updates a symlink at ~/.claude/debug/latest
 */
const updateLatestDebugLogSymlink = memoize(async (): Promise<void> => {
  try {
    const debugLogPath = getDebugLogPath()
    const debugLogsDir = dirname(debugLogPath)
    const latestSymlinkPath = join(debugLogsDir, 'latest')

    await unlink(latestSymlinkPath).catch(() => {})
    await symlink(debugLogPath, latestSymlinkPath)
  } catch {
    // Silently fail if symlink creation fails
  }
})

/**
 * Logs errors for Ants only, always visible in production.
 */
export function logAntError(context: string, error: unknown): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  if (error instanceof Error && error.stack) {
    logForDebugging(`[ANT-ONLY] ${context} stack trace:\n${error.stack}`, {
      level: 'error',
    })
  }
}
