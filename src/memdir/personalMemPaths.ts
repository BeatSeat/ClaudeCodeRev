/**
 * Personal Memory Sync — path validation for the per-account personal memory
 * directory.
 *
 * Personal memory is the auto-memory directory itself (see getPersonalMemPath),
 * synced to the user's account. A handful of reserved subtrees under it —
 * team memory, logs, sessions, proposals — are NOT user-addressable personal
 * memory keys; writes there are rejected by validatePersonalMemKey.
 *
 * Official 2.1.147 (first seen this version; 0 hits in 2.1.146). Feature-gated
 * by tengu_marble_lark, on top of the auto-memory gate.
 *
 * Path-safety helpers (sanitizePathKey, realpathDeepestExisting,
 * realCanonicalMemDir, PathTraversalError) live in teamMemPaths.ts and are
 * shared with team memory.
 */

import { realpath } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getErrnoCode } from '../utils/errors.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'
import {
  getTeamMemPath,
  PathTraversalError,
  realCanonicalMemDir,
  realpathDeepestExisting,
  sanitizePathKey,
} from './teamMemPaths.js'

/**
 * Subtrees of the personal (auto) memory directory that are reserved for
 * non-personal-memory purposes and therefore excluded from personal-memory
 * keys. "team" is team memory; the rest are internal runtime artifacts.
 */
export const PERSONAL_MEM_EXCLUDED_DIRS: string[] = [
  'team',
  'logs',
  'sessions',
  'proposals',
]

/**
 * Whether personal memory sync is enabled.
 * Personal memory lives in the auto-memory directory, so it requires auto
 * memory to be enabled; on top of that it is gated by the tengu_marble_lark
 * feature flag.
 */
export function isPersonalMemorySyncEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_lark', false)
}

/**
 * Returns the personal memory directory: the auto-memory directory itself.
 */
export function getPersonalMemPath(): string {
  return getAutoMemPath()
}

/**
 * Normalize a reserved-segment key fragment for comparison against
 * PERSONAL_MEM_EXCLUDED_DIRS: NFC-normalize, strip trailing dots/spaces, and
 * lowercase, so case/spacing/padding variants of "team" / "logs" / ... are
 * all recognized as reserved.
 */
export function normalizeReservedMemSegment(segment: string): string {
  return segment.normalize('NFC').replace(/[. ]+$/, '').toLowerCase()
}

/**
 * Whether a relative key targets a reserved personal-memory subtree.
 * True when the key is empty, any segment is hidden (dot-prefixed), or the
 * first segment (normalized) is one of PERSONAL_MEM_EXCLUDED_DIRS.
 */
export function isExcludedPersonalMemKey(key: string): boolean {
  const segments = key.split('/')
  if (segments.length === 0) return true
  if (segments.some(segment => segment.startsWith('.'))) return true
  return PERSONAL_MEM_EXCLUDED_DIRS.includes(
    normalizeReservedMemSegment(segments[0]!),
  )
}

/**
 * Check whether a real (symlink-resolved) path is within the real personal
 * memory directory. Both sides compare canonical filesystem locations.
 *
 * If the personal memory directory does not exist, returns true (skips the
 * check) — same reasoning as the team-memory equivalent: a symlink escape
 * requires a pre-existing symlink inside the directory, which requires the
 * directory to exist.
 */
async function isRealPathWithinPersonalMemDir(
  realCandidate: string,
): Promise<boolean> {
  let realPersonalMemDir: string
  try {
    realPersonalMemDir = await realCanonicalMemDir()
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Directory doesn't exist — symlink escape impossible, skip check.
      return true
    }
    // Unexpected error (EACCES, EIO) — fail closed.
    return false
  }
  if (realCandidate === realPersonalMemDir) {
    return true
  }
  // Prefix-attack protection: require separator after the prefix.
  return realCandidate.startsWith(realPersonalMemDir + sep)
}

/**
 * Resolve the canonical (realpath) locations of the reserved subtrees, so the
 * write-path validation can reject keys that resolve *into* them even via a
 * symlink. "team" maps to the team-memory dir; the others sit directly under
 * the personal memory dir. Missing directories are silently skipped.
 */
async function getExcludedPersonalMemRealpaths(): Promise<string[]> {
  const candidates = PERSONAL_MEM_EXCLUDED_DIRS.map(dir =>
    dir === 'team'
      ? getTeamMemPath().replace(/[/\\]+$/, '')
      : join(getPersonalMemPath(), dir),
  )
  const realpaths: string[] = []
  for (const candidate of candidates) {
    try {
      realpaths.push(await realpath(candidate))
    } catch {
      // Directory does not exist — nothing to exclude against.
    }
  }
  return realpaths
}

/**
 * Validate a relative personal-memory key against the personal memory
 * directory. Sanitizes the key, rejects reserved subtrees, resolves symlinks
 * on the deepest existing ancestor, and verifies both string and real
 * containment. Returns the resolved absolute path.
 * Throws PathTraversalError if the key is reserved, escapes the directory via
 * ".." segments, or escapes via a symlink (PSR M22186).
 */
export async function validatePersonalMemKey(key: string): Promise<string> {
  sanitizePathKey(key)
  if (isExcludedPersonalMemKey(key)) {
    throw new PathTraversalError(
      `Key targets an excluded personal-memory subtree: "${key}"`,
    )
  }
  const personalMemDir = getPersonalMemPath()
  const fullPath = join(personalMemDir, key)
  // First pass: normalize .. segments and check string-level containment.
  const resolvedPath = resolve(fullPath)
  if (!resolvedPath.startsWith(personalMemDir)) {
    throw new PathTraversalError(
      `Key escapes personal memory directory: "${key}"`,
    )
  }
  // Second pass: resolve symlinks on the deepest existing ancestor and verify
  // the real path is still within the real personal memory directory.
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinPersonalMemDir(realPath))) {
    throw new PathTraversalError(
      `Key escapes personal memory directory via symlink: "${key}"`,
    )
  }
  // Third pass: reject keys that resolve into a reserved subtree (e.g. a
  // symlink pointing into <mem>/team/).
  for (const excludedReal of await getExcludedPersonalMemRealpaths()) {
    if (realPath === excludedReal || realPath.startsWith(excludedReal + sep)) {
      throw new PathTraversalError(
      `Key resolves into an excluded subtree (${PERSONAL_MEM_EXCLUDED_DIRS.join(
          '/, ',
        )}/): "${key}"`,
      )
    }
  }
  return resolvedPath
}

/**
 * Check if a file path is inside the personal memory directory (and not the
 * directory itself, and not inside a reserved subtree).
 */
export function isPersonalMemPath(filePath: string): boolean {
  const resolvedPath = resolve(filePath).normalize('NFC').toLowerCase()
  const personalMemDir = getPersonalMemPath().normalize('NFC').toLowerCase()
  if (
    resolvedPath + sep !== personalMemDir &&
    !resolvedPath.startsWith(personalMemDir)
  ) {
    return false
  }
  // The personal memory directory itself is not a personal-memory path.
  if (resolvedPath + sep === personalMemDir) {
    return false
  }
  const relativePath = resolvedPath
    .slice(personalMemDir.length)
    .replaceAll(sep, '/')
  return !isExcludedPersonalMemKey(relativePath)
}
