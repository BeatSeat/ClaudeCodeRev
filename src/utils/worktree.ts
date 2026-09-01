import { orphanedWorktreeRemoteFailed } from './worktreeOrphan.js'
void orphanedWorktreeRemoteFailed
import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { spawnSync } from 'child_process'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
} from 'fs/promises'
import ignore from 'ignore'
import { realpath } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { saveCurrentProjectConfig } from './config.js'
import { getCwd } from './cwd.js'
import { getBgSpawnProviderEnv } from './swarm/spawnUtils.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { parseGitConfigValue } from './git/gitConfigParser.js'
import {
  getCommonDir,
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from './git/gitFilesystem.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  getDefaultBranch,
  gitExe,
} from './git.js'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from './hooks.js'
import { containsPathTraversal } from './path.js'
import { getPlatform } from './platform.js'
import {
  getInitialSettings,
  getRelativeSettingsFilePathForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { isInITerm2 } from './swarm/backends/detection.js'

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

/**
 * Validates a worktree slug to prevent path traversal and directory escape.
 *
 * The slug is joined into `.claude/worktrees/<slug>` via path.join, which
 * normalizes `..` segments — so `../../../target` would escape the worktrees
 * directory. Similarly, an absolute path (leading `/` or `C:\`) would discard
 * the prefix entirely.
 *
 * Forward slashes are allowed for nesting (e.g. `asm/feature-foo`); each
 * segment is validated independently against the allowlist, so `.` / `..`
 * segments and drive-spec characters are still rejected.
 *
 * Throws synchronously — callers rely on this running before any side effects
 * (git commands, hook execution, chdir).
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  // Leading or trailing `/` would make path.join produce an absolute path
  // or a dangling segment. Splitting and validating each segment rejects
  // both (empty segments fail the regex) while allowing `user/feature`.
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      )
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

// Helper function to create directories recursively
async function mkdirRecursive(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/**
 * Symlinks directories from the main repository to avoid duplication.
 * This prevents disk bloat from duplicating node_modules and other large directories.
 *
 * @param repoRootPath - Path to the main repository root
 * @param worktreePath - Path to the worktree directory
 * @param dirsToSymlink - Array of directory names to symlink (e.g., ['node_modules'])
 */
async function symlinkDirectories(
  repoRootPath: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const dir of dirsToSymlink) {
    // Validate directory doesn't escape repository boundaries
    if (containsPathTraversal(dir)) {
      logForDebugging(
        `Skipping symlink for "${dir}": path traversal detected`,
        { level: 'warn' },
      )
      continue
    }

    const sourcePath = join(repoRootPath, dir)
    const destPath = join(worktreePath, dir)

    try {
      await symlink(sourcePath, destPath, 'dir')
      logForDebugging(
        `Symlinked ${dir} from main repository to worktree to avoid disk bloat`,
      )
    } catch (error) {
      const code = getErrnoCode(error)
      // ENOENT: source doesn't exist yet (expected - skip silently)
      // EEXIST: destination already exists (expected - skip silently)
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        // Unexpected error (e.g., permission denied, unsupported platform)
        logForDebugging(
          `Failed to symlink ${dir} (${code ?? 'unknown'}): ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
    }
  }
}

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** How long worktree creation took (unset when resuming an existing worktree). */
  creationDurationMs?: number
  /** True if git sparse-checkout was applied via settings.worktree.sparsePaths. */
  usedSparsePaths?: boolean
  /** Official 2.1.105: entered via EnterWorktree `path` instead of creating. */
  enteredExisting?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

export type BgIsolationMode = 'worktree' | 'none'

/**
 * Official 2.1.143 `Ev6`: env CLAUDE_BG_ISOLATION overrides settings
 * `worktree.bgIsolation`.
 */
export function getBgIsolation(): BgIsolationMode | undefined {
  const fromEnv = process.env.CLAUDE_BG_ISOLATION
  if (fromEnv === 'worktree' || fromEnv === 'none') {
    return fromEnv
  }
  return getInitialSettings().worktree?.bgIsolation
}

/** Official 2.1.143 `pq$`: cwd is a linked git worktree, not the main checkout. */
function isLinkedGitWorktree(cwd: string): boolean {
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) return false
  const canonical = findCanonicalGitRoot(cwd)
  return canonical !== null && canonical !== gitRoot
}

/**
 * Official 2.1.143 `lnH`: block bg-session edits of the shared checkout until
 * EnterWorktree isolates the job (unless `worktree.bgIsolation: "none"`).
 * `skip` is the subagent id — isolation is a top-level bg-session concern.
 */
export function getBgFileIsolationMessage(
  filePath: string,
  skip?: string,
): string | null {
  if (process.env.CLAUDE_CODE_SESSION_KIND !== 'bg') return null
  if (skip) return null
  const session = getCurrentWorktreeSession()
  if (session) {
    return filePath.startsWith(session.originalCwd + sep) &&
      !filePath.startsWith(session.worktreePath + sep)
      ? `This session is now isolated in ${session.worktreePath}. Edit the worktree copy of this file instead of the shared-checkout path.`
      : null
  }
  if (getBgIsolation() === 'none') return null
  const cwd = getCwd()
  if (!filePath.startsWith(cwd + sep)) return null
  if (!findGitRoot(cwd) || isLinkedGitWorktree(cwd)) return null
  return (
    `This background session hasn't isolated its changes yet. Call EnterWorktree first so edits land in a worktree instead of the shared checkout, then retry this edit using the worktree path. ` +
    '(To disable this guard for this repo, set `"worktree": {"bgIsolation": "none"}` in .claude/settings.json.)'
  )
}

/**
 * Official 2.1.143 `fp5`: system-prompt section for background sessions.
 */
export function getBackgroundSessionPromptSection(): string | null {
  if (process.env.CLAUDE_CODE_SESSION_KIND !== 'bg') return null
  const jobDir = process.env.CLAUDE_JOB_DIR
  if (!jobDir) return null
  // Official 2.1.144 `ay4` is the env bag Pd() copies into bg spawn. Keep
  // the helper in this bg-session module graph so empty
  // CLAUDE_SECURESTORAGE_CONFIG_DIR survives bundling.
  getBgSpawnProviderEnv()
  const isolationHint =
    getBgIsolation() === 'none'
      ? 'This repository is configured with `worktree.bgIsolation: none` \u2014 edit files directly in your working directory; do not call EnterWorktree.'
      : process.env.CLAUDE_BG_ISOLATION === 'worktree'
        ? 'This agent is configured with `isolation: worktree`. Call the EnterWorktree tool as your first action \u2014 before reading files or running commands \u2014 unless your cwd is already under `.claude/worktrees/`. If EnterWorktree fails (e.g. not a git repo), continue in place.'
        : "Before making any code changes, use the EnterWorktree tool to isolate your work from other parallel jobs and the user's working copy \u2014 unless your cwd is already under `.claude/worktrees/`, in which case you're already isolated. If you're only reading, searching, or answering questions, skip this and work in place. If EnterWorktree fails (e.g. not a git repo), continue in place."
  return `# Background Session

This session runs as a background job. The user may be chatting with you live or may have stepped away to check results later \u2014 respond naturally either way, and don't refer to yourself as "a background agent."

Use \`$CLAUDE_JOB_DIR\` (\`${jobDir}\`) for any temporary files (scripts, query files, intermediate outputs) instead of \`/tmp\` \u2014 parallel bg jobs share \`/tmp\` and clobber each other's files. This directory already exists and is cleaned up when the job is deleted.

${isolationHint}`
}

/**
 * Official Yn4: `--worktree` flag for the resume hint. Entering an existing
 * worktree via EnterWorktree `path` must not add `--worktree` (the session
 * already lives there).
 */
export function getResumeWorktreeArg(): string | null {
  if (currentWorktreeSession) {
    return currentWorktreeSession.enteredExisting
      ? null
      : currentWorktreeSession.worktreeName
  }
  return null
}

/**
 * Restore the worktree session on --resume. The caller must have already
 * verified the directory exists (via process.chdir) and set the bootstrap
 * state (cwd, originalCwd).
 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

export function generateTmuxSessionName(
  repoPath: string,
  branch: string,
): string {
  const repoName = basename(repoPath)
  const combined = `${repoName}_${branch}`
  return combined.replace(/[/.]/g, '_')
}

type WorktreeCreateResult =
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      existed: true
    }
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      baseBranch: string
      existed: false
    }

// Env vars to prevent git/SSH from prompting for credentials (which hangs the CLI).
// GIT_TERMINAL_PROMPT=0 prevents git from opening /dev/tty for credential prompts.
// GIT_ASKPASS='' disables askpass GUI programs.
// stdin: 'ignore' closes stdin so interactive prompts can't block.
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.claude', 'worktrees')
}

// Flatten nested slugs (`user/feature` → `user+feature`) for both the branch
// name and the directory path. Nesting in either location is unsafe:
//   - git refs: `worktree-user` (file) vs `worktree-user/feature` (needs dir)
//     is a D/F conflict that git rejects.
//   - directory: `.claude/worktrees/user/feature/` lives inside the `user`
//     worktree; `git worktree remove` on the parent deletes children with
//     uncommitted work.
// `+` is valid in git branch names and filesystem paths but NOT in the
// slug-segment allowlist ([a-zA-Z0-9._-]), so the mapping is injective.
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug))
}

async function removeOrphanedWorktreeDirectoryIfSafe(
  repoRoot: string,
  worktreePath: string,
  worktreeBranch: string,
): Promise<void> {
  let gitDirectoryPointer: string
  try {
    const dotGitContents = await readFile(join(worktreePath, '.git'), 'utf-8')
    const pointerMatch = dotGitContents.trim().match(/^gitdir:\s*(.+)$/)
    if (!pointerMatch?.[1]) return
    gitDirectoryPointer = isAbsolute(pointerMatch[1])
      ? pointerMatch[1]
      : resolve(worktreePath, pointerMatch[1])
  } catch {
    return
  }

  try {
    await stat(gitDirectoryPointer)
    return
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') return
  }

  const remoteResult = await execFileNoThrowWithCwd(gitExe(), ['remote'], {
    cwd: repoRoot,
  })
  if (remoteResult.code !== 0) {
    throw new Error(
      `Orphaned worktree dir at ${worktreePath} but \`git remote\` failed (${remoteResult.stderr.trim()}) - refusing to self-heal. Remove ${worktreePath} manually if it has no work to keep.`,
    )
  }

  const branchResult = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--verify', '--quiet', worktreeBranch],
    { cwd: repoRoot },
  )
  if (branchResult.code !== 0 && branchResult.stderr.trim().length > 0) {
    throw new Error(
      `Orphaned worktree dir at ${worktreePath} but rev-parse on ${worktreeBranch} failed (${branchResult.stderr.trim()}) - refusing to self-heal. Remove ${worktreePath} manually if it has no work to keep.`,
    )
  }

  if (remoteResult.stdout.trim().length > 0 && branchResult.code === 0) {
    const unpushedResult = await execFileNoThrowWithCwd(
      gitExe(),
      [
        'rev-list',
        '--max-count=1',
        worktreeBranch,
        '--not',
        '--remotes',
      ],
      { cwd: repoRoot },
    )
    if (unpushedResult.code !== 0) {
      throw new Error(
        `Orphaned worktree dir at ${worktreePath} but rev-list on ${worktreeBranch} failed (${unpushedResult.stderr.trim()}) - refusing to self-heal. Remove ${worktreePath} manually if it has no work to keep.`,
      )
    }
    if (unpushedResult.stdout.trim().length > 0) {
      throw new Error(
        `Orphaned worktree dir at ${worktreePath} but branch ${worktreeBranch} has unpushed commits - refusing to self-heal. Push or delete the branch, then retry.`,
      )
    }
  }

  try {
    await rm(worktreePath, { recursive: true, force: true })
    logForDebugging(
      `[worktree] removed orphaned worktree directory at ${worktreePath}`,
    )
  } catch (error) {
    throw new Error(
      `Cannot self-heal orphaned worktree at ${worktreePath}: ${errorMessage(error)}. Remove manually to proceed.`,
    )
  }
}

/**
 * Creates a new git worktree for the given slug, or resumes it if it already exists.
 * Named worktrees reuse the same path across invocations, so the existence check
 * prevents unconditionally running `git fetch` (which can hang waiting for credentials)
 * on every resume.
 */
async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number; fromHead?: boolean },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)

  // Fast resume path: if the worktree already exists skip fetch and creation.
  // Read the .git pointer file directly (no subprocess, no upward walk) — a
  // subprocess `rev-parse HEAD` burns ~15ms on spawn overhead even for a 2ms
  // task, and the await yield lets background spawnSyncs pile on (seen at 55ms).
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    }
  }

  await removeOrphanedWorktreeDirectoryIfSafe(
    repoRoot,
    worktreePath,
    worktreeBranch,
  )

  // New worktree: fetch base branch then add
  await mkdir(worktreesDir(repoRoot), { recursive: true })

  const fetchEnv = { ...process.env, ...GIT_NO_PROMPT_ENV }

  let baseBranch: string
  let baseSha: string | null = null
  const baseRefSetting = getInitialSettings().worktree?.baseRef
  if (options?.fromHead && baseRefSetting === 'head') {
    // Official 2.1.128 EnterWorktree: branch from local HEAD, not origin/.
    baseBranch = 'HEAD'
  } else if (options?.prNumber) {
    const { code: prFetchCode, stderr: prFetchStderr } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', `pull/${options.prNumber}/head`],
        { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
      )
    if (prFetchCode !== 0) {
      throw new Error(
        `Failed to fetch PR #${options.prNumber}: ${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`,
      )
    }
    baseBranch = 'FETCH_HEAD'
  } else {
    // If origin/<branch> already exists locally, skip fetch. In large repos
    // (210k files, 16M objects) fetch burns ~6-8s on a local commit-graph
    // scan before even hitting the network. A slightly stale base is fine —
    // the user can pull in the worktree if they want latest.
    // resolveRef reads the loose/packed ref directly; when it succeeds we
    // already have the SHA, so the later rev-parse is skipped entirely.
    const [defaultBranch, gitDir] = await Promise.all([
      getDefaultBranch(),
      resolveGitDir(repoRoot),
    ])
    const originRef = `origin/${defaultBranch}`
    const originSha = gitDir
      ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
      : null
    if (originSha) {
      baseBranch = originRef
      baseSha = originSha
    } else {
      const { code: fetchCode } = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', defaultBranch],
        { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
      )
      baseBranch = fetchCode === 0 ? originRef : 'HEAD'
    }
  }

  // For the fetch/PR-fetch paths we still need the SHA — the fs-only resolveRef
  // above only covers the "origin/<branch> already exists locally" case.
  if (!baseSha) {
    const { stdout, code: shaCode } = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', baseBranch],
      { cwd: repoRoot },
    )
    if (shaCode !== 0) {
      throw new Error(
        `Failed to resolve base branch "${baseBranch}": git rev-parse failed`,
      )
    }
    baseSha = stdout.trim()
  }

  const sparsePaths = getInitialSettings().worktree?.sparsePaths
  const addArgs = ['worktree', 'add']
  if (sparsePaths?.length) {
    addArgs.push('--no-checkout')
  }
  // -B (not -b): reset any orphan branch left behind by a removed worktree dir.
  // Saves a `git branch -D` subprocess (~15ms spawn overhead) on every create.
  addArgs.push('--no-track', '-B', worktreeBranch, worktreePath, baseBranch)

  const { code: createCode, stderr: createStderr } =
    await execFileNoThrowWithCwd(gitExe(), addArgs, { cwd: repoRoot })
  if (createCode !== 0) {
    throw new Error(`Failed to create worktree: ${createStderr}`)
  }

  if (sparsePaths?.length) {
    // If sparse-checkout or checkout fail after --no-checkout, the worktree
    // is registered and HEAD is set but the working tree is empty. Next run's
    // fast-resume (rev-parse HEAD) would succeed and present a broken worktree
    // as "resumed". Tear it down before propagating the error.
    const tearDown = async (msg: string): Promise<never> => {
      await execFileNoThrowWithCwd(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: repoRoot },
      )
      throw new Error(msg)
    }
    const { code: sparseCode, stderr: sparseErr } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
        { cwd: worktreePath },
      )
    if (sparseCode !== 0) {
      await tearDown(`Failed to configure sparse-checkout: ${sparseErr}`)
    }
    const { code: coCode, stderr: coErr } = await execFileNoThrowWithCwd(
      gitExe(),
      ['checkout', 'HEAD'],
      { cwd: worktreePath },
    )
    if (coCode !== 0) {
      await tearDown(`Failed to checkout sparse worktree: ${coErr}`)
    }
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: baseSha,
    baseBranch,
    existed: false,
  }
}

/**
 * Copy gitignored files specified in .worktreeinclude from base repo to worktree.
 *
 * Only copies files that are BOTH:
 * 1. Matched by patterns in .worktreeinclude (uses .gitignore syntax)
 * 2. Gitignored (not tracked by git)
 *
 * Uses `git ls-files --others --ignored --exclude-standard --directory` to list
 * gitignored entries with fully-ignored dirs collapsed to single entries (so large
 * build outputs like node_modules/ don't force a full tree walk), then filters
 * against .worktreeinclude patterns in-process using the `ignore` library. If a
 * .worktreeinclude pattern explicitly targets a path inside a collapsed directory,
 * that directory is expanded with a second scoped `ls-files` call.
 */
export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let includeContent: string
  try {
    includeContent = await readFile(join(repoRoot, '.worktreeinclude'), 'utf-8')
  } catch {
    return []
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  if (patterns.length === 0) {
    return []
  }

  // Single pass with --directory: collapses fully-gitignored dirs (node_modules/,
  // .turbo/, etc.) into single entries instead of listing every file inside.
  // In a large repo this cuts ~500k entries/~7s down to ~hundreds of entries/~100ms.
  const gitignored = await execFileNoThrowWithCwd(
    gitExe(),
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: repoRoot },
  )
  if (gitignored.code !== 0 || !gitignored.stdout.trim()) {
    return []
  }

  const entries = gitignored.stdout.trim().split('\n').filter(Boolean)
  const matcher = ignore().add(includeContent)

  // --directory emits collapsed dirs with a trailing slash; everything else is
  // an individual file.
  const collapsedDirs = entries.filter(e => e.endsWith('/'))
  const files = entries.filter(e => !e.endsWith('/') && matcher.ignores(e))

  // Edge case: a .worktreeinclude pattern targets a path inside a collapsed dir
  // (e.g. pattern `config/secrets/api.key` when all of `config/secrets/` is
  // gitignored with no tracked siblings). Expand only dirs where a pattern has
  // that dir as its explicit path prefix (stripping redundant leading `/`), the
  // dir falls under an anchored glob's literal prefix (e.g. `config/**/*.key`
  // expands `config/secrets/`), or the dir itself matches a pattern. We don't
  // expand for `**/` or anchorless patterns -- those match files in tracked dirs
  // (already listed individually) and expanding every collapsed dir for them
  // would defeat the perf win.
  const dirsToExpand = collapsedDirs.filter(dir => {
    if (
      patterns.some(p => {
        const normalized = p.startsWith('/') ? p.slice(1) : p
        // Literal prefix match: pattern starts with the collapsed dir path
        if (normalized.startsWith(dir)) return true
        // Anchored glob: dir falls under the pattern's literal (non-glob) prefix
        // e.g. `config/**/*.key` has literal prefix `config/` → expand `config/secrets/`
        const globIdx = normalized.search(/[*?[]/)
        if (globIdx > 0) {
          const literalPrefix = normalized.slice(0, globIdx)
          if (dir.startsWith(literalPrefix)) return true
        }
        return false
      })
    )
      return true
    if (matcher.ignores(dir.slice(0, -1))) return true
    return false
  })
  if (dirsToExpand.length > 0) {
    const expanded = await execFileNoThrowWithCwd(
      gitExe(),
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...dirsToExpand,
      ],
      { cwd: repoRoot },
    )
    if (expanded.code === 0 && expanded.stdout.trim()) {
      for (const f of expanded.stdout.trim().split('\n').filter(Boolean)) {
        if (matcher.ignores(f)) {
          files.push(f)
        }
      }
    }
  }
  const copied: string[] = []

  for (const relativePath of files) {
    const srcPath = join(repoRoot, relativePath)
    const destPath = join(worktreePath, relativePath)
    try {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(srcPath, destPath)
      copied.push(relativePath)
    } catch (e: unknown) {
      logForDebugging(
        `Failed to copy ${relativePath} to worktree: ${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  if (copied.length > 0) {
    logForDebugging(
      `Copied ${copied.length} files from .worktreeinclude: ${copied.join(', ')}`,
    )
  }

  return copied
}

/**
 * Post-creation setup for a newly created worktree.
 * Propagates settings.local.json, configures git hooks, and symlinks directories.
 */
async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  // Copy settings.local.json to the worktree's .claude directory
  // This propagates local settings (which may contain secrets) to the worktree
  const localSettingsRelativePath =
    getRelativeSettingsFilePathForSource('localSettings')
  const sourceSettingsLocal = join(repoRoot, localSettingsRelativePath)
  try {
    const destSettingsLocal = join(worktreePath, localSettingsRelativePath)
    await mkdirRecursive(dirname(destSettingsLocal))
    await copyFile(sourceSettingsLocal, destSettingsLocal)
    logForDebugging(
      `Copied settings.local.json to worktree: ${destSettingsLocal}`,
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to copy settings.local.json: ${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  // Configure the worktree to use hooks from the main repository
  // This solves issues with .husky and other git hooks that use relative paths
  const huskyPath = join(repoRoot, '.husky')
  const gitHooksPath = join(repoRoot, '.git', 'hooks')
  let hooksPath: string | null = null
  for (const candidatePath of [huskyPath, gitHooksPath]) {
    try {
      const s = await stat(candidatePath)
      if (s.isDirectory()) {
        hooksPath = candidatePath
        break
      }
    } catch {
      // Path doesn't exist or can't be accessed
    }
  }
  if (hooksPath) {
    // `git config` (no --worktree flag) writes to the main repo's .git/config,
    // shared by all worktrees. Once set, every subsequent worktree create is a
    // no-op — skip the subprocess (~14ms spawn) when the value already matches.
    const gitDir = await resolveGitDir(repoRoot)
    const configDir = gitDir ? ((await getCommonDir(gitDir)) ?? gitDir) : null
    const existing = configDir
      ? await parseGitConfigValue(configDir, 'core', null, 'hooksPath')
      : null
    if (existing !== hooksPath) {
      const { code: configCode, stderr: configError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['config', 'core.hooksPath', hooksPath],
          { cwd: worktreePath },
        )
      if (configCode === 0) {
        logForDebugging(
          `Configured worktree to use hooks from main repository: ${hooksPath}`,
        )
      } else {
        logForDebugging(`Failed to configure hooks path: ${configError}`, {
          level: 'error',
        })
      }
    }
  }

  // Symlink directories to avoid disk bloat (opt-in via settings)
  const settings = getInitialSettings()
  const dirsToSymlink = settings.worktree?.symlinkDirectories ?? []
  if (dirsToSymlink.length > 0) {
    await symlinkDirectories(repoRoot, worktreePath, dirsToSymlink)
  }

  // Copy gitignored files specified in .worktreeinclude (best-effort)
  await copyWorktreeIncludeFiles(repoRoot, worktreePath)

  // The core.hooksPath config-set above is fragile: husky's prepare script
  // (`git config core.hooksPath .husky`) runs on every `bun install` and
  // resets the SHARED .git/config value back to relative, causing each
  // worktree to resolve to its OWN .husky/ again. The attribution hook
  // file isn't tracked (it's in .git/info/exclude), so fresh worktrees
  // don't have it. Install it directly into the worktree's .husky/ —
  // husky won't delete it (husky install is additive-only), and for
  // non-husky repos this resolves to the shared .git/hooks/ (idempotent).
  //
  // Pass the worktree-local .husky explicitly: getHooksDir would return
  // the absolute core.hooksPath we just set above (main repo's .husky),
  // not the worktree's — `git rev-parse --git-path hooks` echoes the config
  // value verbatim when it's absolute.
  if (feature('COMMIT_ATTRIBUTION')) {
    const worktreeHooksDir =
      hooksPath === huskyPath ? join(worktreePath, '.husky') : undefined
    void import('./postCommitAttribution.js')
      .then(m =>
        m
          .installPrepareCommitMsgHook(worktreePath, worktreeHooksDir)
          .catch(error => {
            logForDebugging(
              `Failed to install attribution hook in worktree: ${error}`,
            )
          }),
      )
      .catch(error => {
        // Dynamic import() itself rejected (module load failure). The inner
        // .catch above only handles installPrepareCommitMsgHook rejection —
        // without this outer handler an import failure would surface as an
        // unhandled promise rejection.
        logForDebugging(`Failed to load postCommitAttribution module: ${error}`)
      })
  }
}

/**
 * Parses a PR reference from a string.
 * Accepts GitHub-style PR URLs (e.g., https://github.com/owner/repo/pull/123,
 * or GHE equivalents like https://ghe.example.com/owner/repo/pull/123)
 * or `#N` format (e.g., #123).
 * Returns the PR number or null if the string is not a recognized PR reference.
 */
export function parsePRReference(input: string): number | null {
  // GitHub-style PR URL: https://<host>/owner/repo/pull/123 (with optional trailing slash, query, hash)
  // The /pull/N path shape is specific to GitHub — GitLab uses /-/merge_requests/N,
  // Bitbucket uses /pull-requests/N — so matching any host here is safe.
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  )
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  // #N format
  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}

export async function isTmuxAvailable(): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', ['-V'])
  return code === 0
}

export function getTmuxInstallInstructions(): string {
  const platform = getPlatform()
  switch (platform) {
    case 'macos':
      return 'Install tmux with: brew install tmux'
    case 'linux':
    case 'wsl':
      return 'Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)'
    case 'windows':
      return 'tmux is not natively available on Windows. Consider using WSL or Cygwin.'
    default:
      return 'Install tmux using your system package manager.'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const { code, stderr } = await execFileNoThrow('tmux', [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    worktreePath,
  ])

  if (code !== 0) {
    return { created: false, error: stderr }
  }

  return { created: true }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', [
    'kill-session',
    '-t',
    sessionName,
  ])
  return code === 0
}

type ListedWorktree = {
  worktreePath: string
  worktreeBranch?: string
}

/** Official 2.1.105 `LeK` — porcelain worktree list with branch. */
async function listGitWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const { code, stdout, stderr, error } = await execFileNoThrowWithCwd(
    gitExe(),
    ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
    { timeout: 10_000 },
  )
  if (code !== 0) {
    throw new Error(
      `\`git -C ${repoRoot} worktree list\` failed: ${stderr.trim() || errorMessage(error) || `exit ${code}`}`,
    )
  }
  const listed: ListedWorktree[] = []
  let current: ListedWorktree | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) listed.push(current)
      current = { worktreePath: line.slice('worktree '.length) }
    } else if (line.startsWith('branch ') && current) {
      current.worktreeBranch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  if (current) listed.push(current)
  return listed
}

/**
 * Switch the session into an existing linked worktree (official 2.1.105 `C57`).
 */
export async function enterExistingWorktreeForSession(
  sessionId: string,
  pathInput: string,
): Promise<WorktreeSession> {
  const originalCwd = getCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd) ?? findGitRoot(originalCwd)
  if (!gitRoot) {
    throw new Error(
      'Cannot enter an existing worktree: the current directory is not in a git repository.',
    )
  }

  const resolvedInput = isAbsolute(pathInput)
    ? pathInput
    : resolve(originalCwd, pathInput)

  let targetPath: string
  let mainPath: string
  let cwdPath: string
  try {
    ;[targetPath, mainPath, cwdPath] = await Promise.all([
      realpath(resolvedInput),
      realpath(gitRoot),
      realpath(originalCwd),
    ])
  } catch (error) {
    throw new Error(`Cannot enter worktree: ${pathInput}: ${errorMessage(error)}`)
  }

  if (targetPath === mainPath) {
    throw new Error(
      `Cannot enter worktree: ${pathInput} is the main working tree, not a linked worktree.`,
    )
  }
  if (targetPath === cwdPath) {
    throw new Error(
      `Cannot enter worktree: ${pathInput} is the current working directory.`,
    )
  }

  const listed = await listGitWorktrees(gitRoot)
  let match: ListedWorktree | undefined
  for (const entry of listed) {
    try {
      if ((await realpath(entry.worktreePath)) === targetPath) {
        match = entry
        break
      }
    } catch {
      // skip unreadable entries
    }
  }
  if (!match) {
    throw new Error(
      `Cannot enter worktree: ${pathInput} is not a registered worktree of ${gitRoot}. Run 'git -C ${gitRoot} worktree list' to see registered worktrees.`,
    )
  }

  currentWorktreeSession = {
    originalCwd,
    worktreePath: targetPath,
    worktreeName: basename(targetPath),
    worktreeBranch: match.worktreeBranch,
    sessionId,
    enteredExisting: true,
  }
  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: currentWorktreeSession ?? undefined,
  }))
  return currentWorktreeSession
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number; fromHead?: boolean },
): Promise<WorktreeSession> {
  // Must run before the hook branch below — hooks receive the raw slug as an
  // argument, and the git branch builds a path from it via path.join.
  validateWorktreeSlug(slug)

  const originalCwd = getCwd()

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based worktree at: ${hookResult.worktreePath}`,
    )

    currentWorktreeSession = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    }
  } else {
    // Fall back to git worktree
    const gitRoot = findGitRoot(getCwd())
    if (!gitRoot) {
      throw new Error(
        'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
          'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
      )
    }

    const originalBranch = await getBranch()

    const createStart = Date.now()
    const { worktreePath, worktreeBranch, headCommit, existed } =
      await getOrCreateWorktree(gitRoot, slug, options)

    let creationDurationMs: number | undefined
    if (existed) {
      logForDebugging(`Resuming existing worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `Created worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
      )
      await performPostCreationSetup(gitRoot, worktreePath)
      creationDurationMs = Date.now() - createStart
    }

    currentWorktreeSession = {
      originalCwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalBranch,
      originalHeadCommit: headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs,
      usedSparsePaths:
        (getInitialSettings().worktree?.sparsePaths?.length ?? 0) > 0,
    }
  }

  // Save to project config for persistence
  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: currentWorktreeSession ?? undefined,
  }))

  return currentWorktreeSession
}

export async function keepWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch } = currentWorktreeSession

    // Change back to original directory first
    process.chdir(originalCwd)

    // Clear the session but keep the worktree intact
    currentWorktreeSession = null

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    logForDebugging(
      `Linked worktree preserved at: ${worktreePath}${worktreeBranch ? ` on branch: ${worktreeBranch}` : ''}`,
    )
    logForDebugging(
      `You can continue working there by running: cd ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(`Error keeping worktree: ${error}`, {
      level: 'error',
    })
  }
}

export async function cleanupWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch, hookBased } =
      currentWorktreeSession

    // Change back to original directory first
    process.chdir(originalCwd)

    if (hookBased) {
      // Hook-based worktree: delegate cleanup to WorktreeRemove hook
      const hookRan = await executeWorktreeRemoveHook(worktreePath)
      if (hookRan) {
        logForDebugging(`Removed hook-based worktree at: ${worktreePath}`)
      } else {
        logForDebugging(
          `No WorktreeRemove hook configured, hook-based worktree left at: ${worktreePath}`,
          { level: 'warn' },
        )
      }
    } else {
      // Git-based worktree: use git worktree remove.
      // Explicit cwd: process.chdir above does NOT update getCwd() (the state
      // CWD that execFileNoThrow defaults to). If the model cd'd to a non-repo
      // dir, the bare execFileNoThrow variant would fail silently here.
      const { code: removeCode, stderr: removeError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: originalCwd },
        )

      if (removeCode !== 0) {
        logForDebugging(`Failed to remove linked worktree: ${removeError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`Removed linked worktree at: ${worktreePath}`)
      }
    }

    // Clear the session
    currentWorktreeSession = null

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    // Delete the temporary worktree branch (git-based only)
    if (!hookBased && worktreeBranch) {
      // Wait a bit to ensure git has released all locks
      await sleep(100)

      const { code: deleteBranchCode, stderr: deleteBranchError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['branch', '-D', worktreeBranch],
          { cwd: originalCwd },
        )

      if (deleteBranchCode !== 0) {
        logForDebugging(
          `Could not delete worktree branch: ${deleteBranchError}`,
          { level: 'error' },
        )
      } else {
        logForDebugging(`Deleted worktree branch: ${worktreeBranch}`)
      }
    }

    logForDebugging('Linked worktree cleaned up completely')
  } catch (error) {
    logForDebugging(`Error cleaning up worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * Create a lightweight worktree for a subagent.
 * Reuses getOrCreateWorktree/performPostCreationSetup but does NOT touch
 * global session state (currentWorktreeSession, process.chdir, project config).
 * Falls back to hook-based creation if not in a git repository.
 */
export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based agent worktree at: ${hookResult.worktreePath}`,
    )

    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  // Fall back to git worktree
  // findCanonicalGitRoot (not findGitRoot) so agent worktrees always land in
  // the main repo's .claude/worktrees/ even when spawned from inside a session
  // worktree — otherwise they nest at <worktree>/.claude/worktrees/ and the
  // periodic cleanup (which scans the canonical root) never finds them.
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      'Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
    )
  }

  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug)

  if (!existed) {
    logForDebugging(
      `Created agent worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
    )
    await performPostCreationSetup(gitRoot, worktreePath)
  } else {
    // Bump mtime so the periodic stale-worktree cleanup doesn't consider this
    // worktree stale — the fast-resume path is read-only and leaves the original
    // creation-time mtime intact, which can be past the 30-day cutoff.
    const now = new Date()
    await utimes(worktreePath, now, now)
    logForDebugging(`Resuming existing agent worktree at: ${worktreePath}`)
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/**
 * Remove a worktree created by createAgentWorktree.
 * For git-based worktrees, removes the worktree directory and deletes the temporary branch.
 * For hook-based worktrees, delegates to the WorktreeRemove hook.
 * Must be called with the main repo's git root (for git worktrees), not the worktree path,
 * since the worktree directory is deleted during this operation.
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) {
    const hookRan = await executeWorktreeRemoveHook(worktreePath)
    if (hookRan) {
      logForDebugging(`Removed hook-based agent worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `No WorktreeRemove hook configured, hook-based agent worktree left at: ${worktreePath}`,
        { level: 'warn' },
      )
    }
    return hookRan
  }

  if (!gitRoot) {
    logForDebugging('Cannot remove agent worktree: no git root provided', {
      level: 'error',
    })
    return false
  }

  // Run from the main repo root, not the worktree (which we're about to delete)
  const { code: removeCode, stderr: removeError } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: gitRoot },
    )

  if (removeCode !== 0) {
    logForDebugging(`Failed to remove agent worktree: ${removeError}`, {
      level: 'error',
    })
    return false
  }
  logForDebugging(`Removed agent worktree at: ${worktreePath}`)

  if (!worktreeBranch) {
    return true
  }

  // Delete the temporary worktree branch from the main repo
  const { code: deleteBranchCode, stderr: deleteBranchError } =
    await execFileNoThrowWithCwd(gitExe(), ['branch', '-D', worktreeBranch], {
      cwd: gitRoot,
    })

  if (deleteBranchCode !== 0) {
    logForDebugging(
      `Could not delete agent worktree branch: ${deleteBranchError}`,
      { level: 'error' },
    )
  }
  return true
}

/**
 * Slug patterns for throwaway worktrees created by AgentTool (`agent-a<7hex>`,
 * from earlyAgentId.slice(0,8)), WorkflowTool (`wf_<runId>-<idx>` where runId
 * is randomUUID().slice(0,12) = 8 hex + `-` + 3 hex), and bridgeMain
 * (`bridge-<safeFilenameId>`). These leak when the parent process is killed
 * (Ctrl+C, ESC, crash) before their in-process cleanup runs. Exact-shape
 * patterns avoid sweeping user-named EnterWorktree slugs like `wf-myfeature`.
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  // Legacy wf-<idx> slugs from before workflowRunId disambiguation — kept so
  // the 30-day sweep still cleans up worktrees leaked by older builds.
  /^wf-\d+$/,
  // Real bridge slugs are `bridge-${safeFilenameId(sessionId)}`.
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  // Template job worktrees: job-<templateName>-<8hex>. Prefix distinguishes
  // from user-named EnterWorktree slugs that happen to end in 8 hex.
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

/**
 * Remove stale agent/workflow worktrees older than cutoffDate.
 *
 * Safety:
 * - Only touches slugs matching ephemeral patterns (never user-named worktrees)
 * - Skips the current session's worktree
 * - Fail-closed: skips if git status fails or shows tracked changes
 *   (-uno: untracked files in a 30-day-old crashed agent worktree are build
 *   artifacts; skipping the untracked scan is 5-10× faster on large repos)
 * - Fail-closed: skips if any commits aren't reachable from a remote
 *
 * `git worktree remove --force` handles both the directory and git's internal
 * worktree tracking. If git doesn't recognize the path as a worktree (orphaned
 * dir), it's left in place — a later readdir finding it stale again is harmless.
 */
/** Official MeY: origin/HEAD, else origin/main, else origin/master. */
async function getDefaultRemoteBranch(
  gitRoot: string,
): Promise<string | null> {
  const head = await execFileNoThrowWithCwd(
    gitExe(),
    ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: gitRoot },
  )
  if (head.code === 0 && head.stdout.trim()) {
    return head.stdout.trim()
  }
  for (const candidate of ['origin/main', 'origin/master'] as const) {
    const verified = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', '--verify', '-q', candidate],
      { cwd: gitRoot },
    )
    if (verified.code === 0) {
      return candidate
    }
  }
  return null
}

/**
 * Official XeY: upstream is gone and cherry-pick vs default has no unique
 * commits — the PR was squash-merged (or the branch is empty vs default).
 */
async function isSquashMergedIntoDefault(
  worktreePath: string,
  defaultBranch: string,
): Promise<boolean> {
  const headRef = await execFileNoThrowWithCwd(
    gitExe(),
    ['symbolic-ref', '-q', 'HEAD'],
    { cwd: worktreePath },
  )
  const ref = headRef.stdout.trim()
  if (headRef.code !== 0 || !ref) {
    return false
  }
  const track = await execFileNoThrowWithCwd(
    gitExe(),
    ['for-each-ref', '--format=%(upstream:track,nobracket)', ref],
    { cwd: worktreePath },
  )
  if (track.code !== 0 || track.stdout.trim() !== 'gone') {
    return false
  }
  const unique = await execFileNoThrowWithCwd(
    gitExe(),
    [
      'rev-list',
      '--cherry-pick',
      '--right-only',
      '--no-merges',
      '--max-count=1',
      `${defaultBranch}...HEAD`,
    ],
    { cwd: worktreePath },
  )
  return unique.code === 0 && unique.stdout.trim().length === 0
}

export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    return 0
  }

  const dir = worktreesDir(gitRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const cutoffMs = cutoffDate.getTime()
  const currentPath = currentWorktreeSession?.worktreePath
  const defaultBranch = await getDefaultRemoteBranch(gitRoot)
  let removed = 0

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))) {
      continue
    }

    const worktreePath = join(dir, slug)
    if (currentPath === worktreePath) {
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) {
      continue
    }

    // Both checks must succeed with empty output. Non-zero exit (corrupted
    // worktree, git not recognizing it, etc.) means skip — we don't know
    // what's in there.
    const [status, unpushed] = await Promise.all([
      execFileNoThrowWithCwd(
        gitExe(),
        ['--no-optional-locks', 'status', '--porcelain', '-uno'],
        { cwd: worktreePath },
      ),
      execFileNoThrowWithCwd(
        gitExe(),
        ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath },
      ),
    ])
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      continue
    }
    if (unpushed.code !== 0) {
      continue
    }
    if (unpushed.stdout.trim().length > 0) {
      if (
        defaultBranch === null ||
        !(await isSquashMergedIntoDefault(worktreePath, defaultBranch))
      ) {
        continue
      }
    }

    if (
      await removeAgentWorktree(worktreePath, worktreeBranchName(slug), gitRoot)
    ) {
      removed++
    }
  }

  if (removed > 0) {
    await execFileNoThrowWithCwd(gitExe(), ['worktree', 'prune'], {
      cwd: gitRoot,
    })
    logForDebugging(
      `cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`,
    )
  }
  return removed
}

/**
 * Check whether a worktree has uncommitted changes or new commits since creation.
 * Returns true if there are uncommitted changes (dirty working tree), if commits
 * were made on the worktree branch since `headCommit`, or if git commands fail
 * — callers use this to decide whether to remove a worktree, so fail-closed.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } =
    await execFileNoThrowWithCwd(gitExe(), ['status', '--porcelain'], {
      cwd: worktreePath,
    })
  if (statusCode !== 0) {
    return true
  }
  if (statusOutput.trim().length > 0) {
    return true
  }

  const { code: revListCode, stdout: revListOutput } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-list', '--count', `${headCommit}..HEAD`],
      { cwd: worktreePath },
    )
  if (revListCode !== 0) {
    return true
  }
  const commitsAhead = Number.parseInt(revListOutput.trim(), 10)
  if (!Number.isFinite(commitsAhead) || commitsAhead > 0) {
    return true
  }

  return false
}

/**
 * Fast-path handler for --worktree --tmux.
 * Creates the worktree and execs into tmux running Claude inside.
 * This is called early in cli.tsx before loading the full CLI.
 */
export async function execIntoTmuxWorktree(args: string[]): Promise<{
  handled: boolean
  error?: string
}> {
  // Check platform - tmux doesn't work on Windows
  if (process.platform === 'win32') {
    return {
      handled: false,
      error: 'Error: --tmux is not supported on Windows',
    }
  }

  // Check if tmux is available
  const tmuxCheck = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
  if (tmuxCheck.status !== 0) {
    const installHint =
      process.platform === 'darwin'
        ? 'Install tmux with: brew install tmux'
        : 'Install tmux with: sudo apt install tmux'
    return {
      handled: false,
      error: `Error: tmux is not installed. ${installHint}`,
    }
  }

  // Parse worktree name and tmux mode from args
  let worktreeName: string | undefined
  let forceClassicTmux = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '-w' || arg === '--worktree') {
      // Check if next arg exists and isn't another flag
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        worktreeName = next
      }
    } else if (arg.startsWith('--worktree=')) {
      worktreeName = arg.slice('--worktree='.length)
    } else if (arg === '--tmux=classic') {
      forceClassicTmux = true
    }
  }

  // Check if worktree name is a PR reference
  let prNumber: number | null = null
  if (worktreeName) {
    prNumber = parsePRReference(worktreeName)
    if (prNumber !== null) {
      worktreeName = `pr-${prNumber}`
    }
  }

  // Generate a slug if no name provided
  if (!worktreeName) {
    const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold']
    const nouns = ['fox', 'owl', 'elm', 'oak', 'ray']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]
    const suffix = Math.random().toString(36).slice(2, 6)
    worktreeName = `${adj}-${noun}-${suffix}`
  }

  // worktreeName is joined into worktreeDir via path.join below; apply the
  // same allowlist used by the in-session worktree tool so the constraint
  // holds uniformly regardless of entry point.
  try {
    validateWorktreeSlug(worktreeName)
  } catch (e) {
    return {
      handled: false,
      error: `Error: ${(e as Error).message}`,
    }
  }

  // Mirror createWorktreeForSession(): hook takes precedence over git so the
  // WorktreeCreate hook substitutes the VCS backend for this fast-path too
  // (anthropics/claude-code#39281). Git path below runs only when no hook.
  let worktreeDir: string
  let repoName: string
  if (hasWorktreeCreateHook()) {
    try {
      const hookResult = await executeWorktreeCreateHook(worktreeName)
      worktreeDir = hookResult.worktreePath
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
    repoName = basename(findCanonicalGitRoot(getCwd()) ?? getCwd())
    // biome-ignore lint/suspicious/noConsole: intentional console output
    console.log(`Using worktree via hook: ${worktreeDir}`)
  } else {
    // Get main git repo root (resolves through worktrees)
    const repoRoot = findCanonicalGitRoot(getCwd())
    if (!repoRoot) {
      return {
        handled: false,
        error: 'Error: --worktree requires a git repository',
      }
    }

    repoName = basename(repoRoot)
    worktreeDir = worktreePathFor(repoRoot, worktreeName)

    // Create or resume worktree
    try {
      const result = await getOrCreateWorktree(
        repoRoot,
        worktreeName,
        prNumber !== null ? { prNumber } : undefined,
      )
      if (!result.existed) {
        // biome-ignore lint/suspicious/noConsole: intentional console output
        console.log(
          `Created worktree: ${worktreeDir} (based on ${result.baseBranch})`,
        )
        await performPostCreationSetup(repoRoot, worktreeDir)
      }
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
  }

  // Sanitize for tmux session name (replace / and . with _)
  const tmuxSessionName =
    `${repoName}_${worktreeBranchName(worktreeName)}`.replace(/[/.]/g, '_')

  // Build new args without --tmux and --worktree (we're already in the worktree)
  const newArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--tmux' || arg === '--tmux=classic') continue
    if (arg === '-w' || arg === '--worktree') {
      // Skip the flag and its value if present
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        i++ // Skip the value too
      }
      continue
    }
    if (arg.startsWith('--worktree=')) continue
    newArgs.push(arg)
  }

  // Get tmux prefix for user guidance
  let tmuxPrefix = 'C-b' // default
  const prefixResult = spawnSync('tmux', ['show-options', '-g', 'prefix'], {
    encoding: 'utf-8',
  })
  if (prefixResult.status === 0 && prefixResult.stdout) {
    const match = prefixResult.stdout.match(/prefix\s+(\S+)/)
    if (match?.[1]) {
      tmuxPrefix = match[1]
    }
  }

  // Check if tmux prefix conflicts with Claude keybindings
  // Claude binds: ctrl+b (task:background), ctrl+c, ctrl+d, ctrl+t, ctrl+o, ctrl+r, ctrl+s, ctrl+g, ctrl+e
  const claudeBindings = [
    'C-b',
    'C-c',
    'C-d',
    'C-t',
    'C-o',
    'C-r',
    'C-s',
    'C-g',
    'C-e',
  ]
  const prefixConflicts = claudeBindings.includes(tmuxPrefix)

  // Set env vars for the inner Claude to display tmux info in welcome message
  const tmuxEnv = {
    ...process.env,
    CLAUDE_CODE_TMUX_SESSION: tmuxSessionName,
    CLAUDE_CODE_TMUX_PREFIX: tmuxPrefix,
    CLAUDE_CODE_TMUX_PREFIX_CONFLICTS: prefixConflicts ? '1' : '',
  }

  // Check if session already exists
  const hasSessionResult = spawnSync(
    'tmux',
    ['has-session', '-t', tmuxSessionName],
    { encoding: 'utf-8' },
  )
  const sessionExists = hasSessionResult.status === 0

  // Check if we're already inside a tmux session
  const isAlreadyInTmux = Boolean(process.env.TMUX)

  // Use tmux control mode (-CC) for native iTerm2 tab/pane integration
  // This lets users use iTerm2's UI instead of learning tmux keybindings
  // Use --tmux=classic to force traditional tmux even in iTerm2
  // Control mode doesn't make sense when already in tmux (would need to switch-client)
  const useControlMode = isInITerm2() && !forceClassicTmux && !isAlreadyInTmux
  const tmuxGlobalArgs = useControlMode ? ['-CC'] : []

  // Print hint about iTerm2 preferences when using control mode
  if (useControlMode && !sessionExists) {
    const y = chalk.yellow
    // biome-ignore lint/suspicious/noConsole: intentional user guidance
    console.log(
      `\n${y('╭─ iTerm2 Tip ────────────────────────────────────────────────────────╮')}\n` +
        `${y('│')} To open as a tab instead of a new window:                           ${y('│')}\n` +
        `${y('│')} iTerm2 > Settings > General > tmux > "Tabs in attaching window"     ${y('│')}\n` +
        `${y('╰─────────────────────────────────────────────────────────────────────╯')}\n`,
    )
  }

  // For ants in claude-cli-internal, set up dev panes (watch + start)
  const isAnt = process.env.USER_TYPE === 'ant'
  const isClaudeCliInternal = repoName === 'claude-cli-internal'
  const shouldSetupDevPanes = isAnt && isClaudeCliInternal && !sessionExists

  if (shouldSetupDevPanes) {
    // Create detached session with Claude in first pane
    spawnSync(
      'tmux',
      [
        'new-session',
        '-d', // detached
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--',
        process.execPath,
        ...newArgs,
      ],
      { cwd: worktreeDir, env: tmuxEnv },
    )

    // Split horizontally and run watch
    spawnSync(
      'tmux',
      ['split-window', '-h', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync(
      'tmux',
      ['send-keys', '-t', tmuxSessionName, 'bun run watch', 'Enter'],
      { cwd: worktreeDir },
    )

    // Split vertically and run start
    spawnSync(
      'tmux',
      ['split-window', '-v', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync('tmux', ['send-keys', '-t', tmuxSessionName, 'bun run start'], {
      cwd: worktreeDir,
    })

    // Select the first pane (Claude)
    spawnSync('tmux', ['select-pane', '-t', `${tmuxSessionName}:0.0`], {
      cwd: worktreeDir,
    })

    // Attach or switch to the session
    if (isAlreadyInTmux) {
      // Switch to sibling session (avoid nesting)
      spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
        stdio: 'inherit',
      })
    } else {
      // Attach to the session
      spawnSync(
        'tmux',
        [...tmuxGlobalArgs, 'attach-session', '-t', tmuxSessionName],
        {
          stdio: 'inherit',
          cwd: worktreeDir,
        },
      )
    }
  } else {
    // Standard behavior: create or attach
    if (isAlreadyInTmux) {
      // Already in tmux - create detached session, then switch to it (sibling)
      // Check if session already exists first
      if (sessionExists) {
        // Just switch to existing session
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      } else {
        // Create new detached session
        spawnSync(
          'tmux',
          [
            'new-session',
            '-d', // detached
            '-s',
            tmuxSessionName,
            '-c',
            worktreeDir,
            '--',
            process.execPath,
            ...newArgs,
          ],
          { cwd: worktreeDir, env: tmuxEnv },
        )

        // Switch to the new session
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      }
    } else {
      // Not in tmux - create and attach (original behavior)
      const tmuxArgs = [
        ...tmuxGlobalArgs,
        'new-session',
        '-A', // Attach if exists, create if not
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--', // Separator before command
        process.execPath,
        ...newArgs,
      ]

      spawnSync('tmux', tmuxArgs, {
        stdio: 'inherit',
        cwd: worktreeDir,
        env: tmuxEnv,
      })
    }
  }

  return { handled: true }
}
