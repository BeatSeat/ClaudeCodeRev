import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { expandPath } from '../../utils/path.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'

const SED_RANGE_PRINT = /^(\d+),(\d+)p$/
const SED_LINE_PRINT = /^(\d+)p$/
const SILENT_COMPANION = /^\s*(echo|printf|true|:)\b/
const MAX_SEED_BYTES = 10 * 1024 * 1024

type SeededRead = {
  filePath: string
  startLine: number | undefined
  endLine: number | undefined
  requiresExitZero?: boolean
}

const GREP_SHORT_FLAGS = /^-[niwxEFGPHh]+$/
const GREP_CONTEXT_SHORT = /^-[ABC]\d+$/
const GREP_CONTEXT_LONG =
  /^--(?:after-context|before-context|context)=\d+$/
const GREP_ALLOWED_LONG = new Set([
  '--line-number',
  '--ignore-case',
  '--word-regexp',
  '--line-regexp',
  '--extended-regexp',
  '--fixed-strings',
  '--basic-regexp',
  '--perl-regexp',
  '--with-filename',
  '--no-filename',
  '--color=never',
  '--color=auto',
])

function tokenizeSimpleArgv(command: string): string[] | null {
  const parsed = tryParseShellCommand(command)
  if (!parsed.success) {
    return null
  }
  const args: string[] = []
  for (const token of parsed.tokens) {
    if (typeof token !== 'string') {
      return null
    }
    args.push(token)
  }
  return args.length > 0 ? args : null
}

function parseReadonlySedPrint(command: string): SeededRead | null {
  const argv = tokenizeSimpleArgv(command)
  if (!argv || argv[0] !== 'sed') {
    return null
  }
  let quiet = false
  let expression: string | null = null
  let filePath: string | null = null
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-')) {
      if (arg.startsWith('--')) {
        if (arg === '--in-place' || arg.startsWith('--in-place=')) {
          return null
        }
        if (arg === '--expression') {
          return null
        }
        if (arg === '--quiet' || arg === '--silent') {
          quiet = true
        }
      } else {
        if (arg.includes('i')) {
          return null
        }
        if (arg === '-e') {
          return null
        }
        if (arg.includes('n')) {
          quiet = true
        }
      }
      continue
    }
    if (expression === null) {
      expression = arg
    } else if (filePath === null) {
      filePath = arg
    } else {
      return null
    }
  }
  if (!quiet || expression === null || filePath === null) {
    return null
  }
  const range = SED_RANGE_PRINT.exec(expression)
  if (range) {
    return {
      filePath,
      startLine: Number(range[1]),
      endLine: Number(range[2]),
    }
  }
  const line = SED_LINE_PRINT.exec(expression)
  if (line) {
    const n = Number(line[1])
    return { filePath, startLine: n, endLine: n }
  }
  return null
}

function parseReadonlyCat(command: string): SeededRead | null {
  const argv = tokenizeSimpleArgv(command)
  if (!argv || argv[0] !== 'cat') {
    return null
  }
  let filePath: string | null = null
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-')) {
      if (arg !== '-n' && arg !== '--number') {
        return null
      }
      continue
    }
    if (filePath !== null) {
      return null
    }
    filePath = arg
  }
  if (filePath === null || filePath === '-') {
    return null
  }
  return { filePath, startLine: undefined, endLine: undefined }
}

/** Official 2.1.160 `E$A` — single-file grep/egrep/fgrep seeds read-before-edit. */
function parseReadonlyGrep(command: string): SeededRead | null {
  const argv = tokenizeSimpleArgv(command)
  if (
    !argv ||
    (argv[0] !== 'grep' && argv[0] !== 'egrep' && argv[0] !== 'fgrep')
  ) {
    return null
  }
  let pattern: string | null = null
  let filePath: string | null = null
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-') && arg !== '-') {
      if (arg === '-A' || arg === '-B' || arg === '-C') {
        const next = argv[++i]
        if (next === undefined || !/^\d+$/.test(next)) {
          return null
        }
        continue
      }
      if (
        GREP_CONTEXT_SHORT.test(arg) ||
        GREP_CONTEXT_LONG.test(arg) ||
        GREP_SHORT_FLAGS.test(arg) ||
        GREP_ALLOWED_LONG.has(arg)
      ) {
        continue
      }
      return null
    }
    if (pattern === null) {
      pattern = arg
    } else if (filePath === null) {
      filePath = arg
    } else {
      return null
    }
  }
  if (pattern === null || filePath === null || filePath === '-') {
    return null
  }
  if (/[*?[{]/.test(filePath)) {
    return null
  }
  return {
    filePath,
    startLine: undefined,
    endLine: undefined,
    requiresExitZero: true,
  }
}

function collectReadonlyFileReads(command: string): SeededRead[] {
  if (/[|<>]/.test(command)) {
    return []
  }
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    return []
  }
  if (subcommands.length === 0) {
    return []
  }
  const reads: SeededRead[] = []
  for (const sub of subcommands) {
    const parsed =
      parseReadonlySedPrint(sub) ??
      parseReadonlyCat(sub) ??
      (subcommands.length === 1 ? parseReadonlyGrep(sub) : null)
    if (parsed) {
      reads.push(parsed)
    } else if (subcommands.length > 1 && !SILENT_COMPANION.test(sub)) {
      return []
    }
  }
  return reads
}

/**
 * After a successful read-only `sed -n` / `cat` Bash command, seed
 * readFileState so a later Edit does not require a redundant Read.
 * Official 2.1.89 SPK / 2.1.98 xl4.
 */
export async function seedReadFileStateFromReadonlyBash(
  command: string,
  readFileState: FileStateCache,
  signal: AbortSignal,
  exitCode?: number,
): Promise<void> {
  const reads = collectReadonlyFileReads(command).filter(
    read => !read.requiresExitZero || exitCode === 0,
  )
  if (reads.length === 0) {
    return
  }
  const fs = getFsImplementation()
  await Promise.all(
    reads.map(async read => {
      const absolute = expandPath(read.filePath)
      if (readFileState.has(absolute)) {
        return
      }
      try {
        const stats = await fs.stat(absolute)
        if (stats.size > MAX_SEED_BYTES) {
          return
        }
        if (signal.aborted) {
          return
        }
        const raw = await fs.readFile(absolute, { encoding: 'utf8' })
        let content: string
        let offset: number | undefined
        let limit: number | undefined
        if (read.startLine === undefined) {
          content = raw
        } else {
          const lines = raw.split('\n')
          const start = Math.max(1, read.startLine)
          const end = Math.max(start, read.endLine ?? start)
          if (start > lines.length) {
            return
          }
          content = lines.slice(start - 1, end).join('\n')
          offset = start
          limit = end - start + 1
        }
        readFileState.set(absolute, {
          content,
          timestamp: Math.floor(stats.mtimeMs),
          offset,
          limit,
        })
      } catch {
        // Missing/unreadable files are ignored — same as official SPK/xl4.
      }
    }),
  )
}
