import { execFileSync } from 'child_process'
import memoize from 'lodash-es/memoize.js'
import * as path from 'path'
import * as pathWin32 from 'path/win32'
import { logForDebugging } from './debug.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { memoizeWithLRU } from './memoize.js'
import { getPlatform } from './platform.js'

/** Official 2.1.117 hB6 — process-lifetime where.exe cache */
const whereExeCache = new Map<string, string>()

/**
 * Check if a file or directory exists on Windows using the dir command
 * @param path - The path to check
 * @returns true if the path exists, false otherwise
 */
function checkPathExists(path: string): boolean {
  try {
    execSync_DEPRECATED(`dir "${path}"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Find an executable using where.exe on Windows
 * @param executable - The name of the executable to find
 * @returns The path to the executable or null if not found
 */
function findExecutable(executable: string): string | null {
  // For git, check common installation locations first
  if (executable === 'git') {
    const defaultLocations = [
      // check 64 bit before 32 bit
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      // intentionally don't look for C:\Program Files\Git\mingw64\bin\git.exe
      // because that directory is the "raw" tools with no environment setup
    ]

    for (const location of defaultLocations) {
      if (checkPathExists(location)) {
        return location
      }
    }
  }

  return findViaWhereExe(executable)
}

/**
 * Official 2.1.117 sJ8: cached where.exe lookup that skips cwd (unsafe).
 */
export function findViaWhereExe(executable: string): string | null {
  const cached = whereExeCache.get(executable)
  if (cached !== undefined) {
    return cached
  }

  const systemRoot = process.env.SYSTEMROOT || 'C:\\Windows'
  const whereExe = path.join(systemRoot, 'System32', 'where.exe')
  try {
    const result = execFileSync(whereExe, [executable], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
    const cwd = process.cwd().toLowerCase()

    for (const candidatePath of result) {
      const normalizedPath = path.resolve(candidatePath).toLowerCase()
      if (
        path.dirname(normalizedPath).toLowerCase() === cwd ||
        normalizedPath.startsWith(cwd + path.sep)
      ) {
        logForDebugging(
          `Skipping potentially malicious executable in current directory: ${candidatePath}`,
        )
        continue
      }
      whereExeCache.set(executable, candidatePath)
      return candidatePath
    }

    return null
  } catch {
    return null
  }
}

/**
 * Official 2.1.117 tJ8: resolve a bare command name via cached where.exe.
 * Path-like commands and non-Windows are returned unchanged.
 */
export function resolveCommandOnWindows(command: string): string | null {
  if (getPlatform() !== 'windows') {
    return command
  }
  if (command.includes('/') || command.includes('\\')) {
    return command
  }
  return findViaWhereExe(command)
}

export function assertWindowsSpawnCommand(command: string): string {
  const resolved = resolveCommandOnWindows(command)
  if (resolved === null) {
    throw new Error(
      `Command '${command}' not found or is in an unsafe location (current directory)`,
    )
  }
  return resolved
}

/**
 * If Windows, set the SHELL environment variable to git-bash path.
 * This is used by BashTool and Shell.ts for user shell commands.
 * COMSPEC is left unchanged for system process execution.
 */
export function setShellIfWindows(): void {
  if (getPlatform() === 'windows') {
    const gitBashPath = findGitBashPath()
    process.env.SHELL = gitBashPath
    logForDebugging(`Using bash path: "${gitBashPath}"`)
  }
}

/**
 * Find the path where `bash.exe` included with git-bash exists, exiting the process if not found.
 */
export const findGitBashPath = memoize((): string => {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (checkPathExists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH
    }
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH path "${process.env.CLAUDE_CODE_GIT_BASH_PATH}"`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const gitPath = findExecutable('git')
  if (gitPath) {
    const bashPath = pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe')
    if (checkPathExists(bashPath)) {
      return bashPath
    }
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    'Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
})

/** Convert a Windows path to a POSIX path using pure JS. */
export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    // Handle UNC paths: \\server\share -> //server/share
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/')
    }
    // Handle drive letter paths: C:\Users\foo -> /c/Users/foo
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
    if (match) {
      const driveLetter = match[1]!.toLowerCase()
      return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
    }
    // Already POSIX or relative — just flip slashes
    return windowsPath.replace(/\\/g, '/')
  },
  (p: string) => p,
  500,
)

/** Convert a POSIX path to a Windows path using pure JS. */
export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    // Handle UNC paths: //server/share -> \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    // Handle /cygdrive/c/... format
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Handle /c/... format (MSYS2/Git Bash)
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Already Windows or relative — just flip slashes
    return posixPath.replace(/\//g, '\\')
  },
  (p: string) => p,
  500,
)
