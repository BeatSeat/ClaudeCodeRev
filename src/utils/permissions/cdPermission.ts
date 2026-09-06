import { existsSync, readlinkSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { expandPath } from '../path.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { getCwd } from '../cwd.js'
import { getPlatform } from '../platform.js'
import {
  getAllowRules,
  getDenyRules,
} from './permissions.js'
import type {
  PermissionRule,
  PermissionRuleSource,
} from './PermissionRule.js'
import { relativePath } from './filesystem.js'

/**
 * Official 2.1.169 /cd permission check (`kQ4` and helpers). Deny rules for
 * the `Cd` tool turn /cd off (bare `Cd`) or exclude directory patterns;
 * allow rules limit /cd to the matching directories. With no Cd rules the
 * check allows everything.
 */

const CD_TOOL_NAME = 'Cd'

export type CdPermissionInput = {
  requestedPath: string
  canonicalPath: string
}

export type CdPermissionCheck =
  | { result: 'allowed' }
  | { result: 'blockedByRule'; rule: PermissionRule }
  | { result: 'outsideAllowedPatterns'; allowedPatterns: string[] }

export function checkCdPermission(
  input: CdPermissionInput,
  context: ToolPermissionContext,
): CdPermissionCheck {
  const denyCandidates = dedupe([
    ...getPathCandidates(input.requestedPath),
    input.canonicalPath,
  ])
  const allowCandidates = dedupe([
    input.canonicalPath,
    stripMacOSVanityPrefix(input.canonicalPath),
  ])
  const matchesAny = (
    pattern: string,
    source: PermissionRuleSource,
    candidates: string[],
  ): boolean => candidates.some(path => cdPatternMatches(pattern, source, path))

  for (const rule of getDenyRules(context)) {
    if (rule.ruleValue.toolName !== CD_TOOL_NAME) continue
    const ruleContent = rule.ruleValue.ruleContent
    if (
      ruleContent === undefined ||
      matchesAny(ruleContent, rule.source, denyCandidates)
    ) {
      return { result: 'blockedByRule', rule }
    }
  }

  const allowRules = getAllowRules(context).filter(
    rule => rule.ruleValue.toolName === CD_TOOL_NAME,
  )
  if (allowRules.length === 0) {
    return { result: 'allowed' }
  }
  for (const rule of allowRules) {
    const ruleContent = rule.ruleValue.ruleContent
    if (
      ruleContent === undefined ||
      matchesAny(ruleContent, rule.source, allowCandidates)
    ) {
      return { result: 'allowed' }
    }
  }
  return {
    result: 'outsideAllowedPatterns',
    allowedPatterns: allowRules
      .map(rule => rule.ruleValue.ruleContent)
      .filter((content): content is string => content !== undefined),
  }
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)]
}

/**
 * Parse a Cd rule pattern into {relativePattern, root} (Official 2.1.169
 * `O4q`): absolute/UNC/home patterns carry their own root; source-relative
 * patterns anchor at the rule source's directory; bare relative patterns
 * anchor at the current cwd.
 */
function parseCdPattern(
  pattern: string,
  source: PermissionRuleSource,
): { relativePattern: string; root: string | null } {
  const platform = getPlatform()
  if (
    platform === 'windows' &&
    ((pattern.startsWith('~\\') ||
      (pattern.startsWith('\\') && pattern[1] !== '!' && pattern[1] !== '#')))
  ) {
    pattern = pattern.replaceAll('\\', '/')
  }
  const sepStr = sep
  if (pattern.startsWith(`${sepStr}${sepStr}`)) {
    // UNC path — `\\server\share` becomes a rooted pattern
    const rest = pattern.slice(1)
    if (platform === 'windows' && rest.match(/^\/[a-z]\//i)) {
      const drive = (rest[1]?.toUpperCase() ?? 'C')
      const tail = rest.slice(2)
      const root = `${drive}:\\`
      return { relativePattern: tail.startsWith('/') ? tail : '/' + tail, root }
    }
    return { relativePattern: rest, root: sepStr }
  }
  if (platform === 'windows' && pattern.match(/^[A-Za-z]:[/\\]/)) {
    const drive = pattern[0]!.toUpperCase()
    const tail = pattern.slice(2).replaceAll('\\', '/')
    return {
      relativePattern: tail.startsWith('/') ? tail : '/' + tail,
      root: `${drive}:\\`,
    }
  }
  if (pattern.startsWith(`~${sepStr}`)) {
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  }
  if (pattern.startsWith(sepStr)) {
    return { relativePattern: pattern, root: ruleSourceRoot(source) }
  }
  let relative = pattern
  if (pattern.startsWith(`.${sepStr}`)) {
    relative = pattern.slice(2)
  }
  return { relativePattern: relative, root: null }
}

/**
 * Directory a rule's relative patterns are anchored to (Official 2.1.169
 * `Waf`): CLI/session rules anchor at the original cwd; user settings rules
 * anchor at the config home; project/local/flag/policy rules anchor at the
 * working directory (flag settings at the --settings file's directory).
 */
function ruleSourceRoot(source: PermissionRuleSource): string {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
    case 'toolsNarrowing':
      return expandPath(getOriginalCwd())
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
      return resolve(getOriginalCwd())
    case 'flagSettings':
      return resolve(getOriginalCwd())
  }
}

/**
 * Gitignore-style glob → RegExp (Official 2.1.169 `Q2f`). `**/` matches any
 * number of leading directories, `/**` matches any trailing depth, `*`
 * matches within one segment. Case-insensitive, anchored at the end.
 */
function cdGlobToRegExp(glob: string): RegExp {
  let regex = '^'
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (i === 0 && char === '*' && glob[1] === '*' && glob[2] === '/') {
      regex += '(?:.*/)?'
      i += 2
    } else if (char === '/' && glob[i + 1] === '*' && glob[i + 2] === '*') {
      regex += '(/.*)?'
      i += 2
    } else if (char === '*') {
      if (glob[i + 1] === '*') {
        regex += '.*'
        i++
      } else {
        regex += '[^/]+'
      }
    } else if ('\\^$.|?+()[]{}'.includes(char)) {
      regex += `\\${char}`
    } else {
      regex += char
    }
  }
  return new RegExp(`${regex}$`, 'i')
}

/**
 * Does one candidate path match a Cd rule pattern (Official 2.1.169 `F2f`)?
 * The candidate must live under the pattern's root (or cwd for rootless
 * patterns) and match the relative glob.
 */
function cdPatternMatches(
  pattern: string,
  source: PermissionRuleSource,
  candidatePath: string,
): boolean {
  const { relativePattern, root } = parseCdPattern(pattern, source)
  const relative = relativePath(root ?? getCwd(), candidatePath)
  if (relative === '..' || relative.startsWith('../')) return false
  const normalized = relativePattern
    .replace(/\/{2,}/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '')
  return cdGlobToRegExp(normalized).test(relative)
}

/**
 * macOS `/private` symlink-vanity prefixes (Official 2.1.169 `MC8`/`Gaf`):
 * map /private/tmp → /tmp etc. so realpath'd and logical paths compare
 * equal.
 */
const MACOS_VANITY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['/private/tmp', '/tmp'],
  ['/private/var', '/var'],
  ['/private/etc', '/etc'],
  ['/usr/bin', '/bin'],
  ['/usr/lib', '/lib'],
  ['/usr/sbin', '/sbin'],
]

function stripMacOSVanityPrefix(path: string): string {
  for (const [vanity, canonical] of MACOS_VANITY_PREFIXES) {
    if (path === vanity || path.startsWith(vanity + sep)) {
      return canonical + path.slice(vanity.length)
    }
  }
  return path
}

function isUncPath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

function isWslPath(path: string): boolean {
  return /^[\\/]{2}wsl(\$|\.localhost)[\\/]/i.test(path)
}

/**
 * Candidate absolute paths for a requested path (Official 2.1.169 `fN`):
 * the ~-expanded path plus every symlink-target variant along its chain,
 * and the realpath when it differs. Deny matching checks all variants so a
 * symlink can't dodge a rule.
 */
function getPathCandidates(requestedPath: string): string[] {
  let expanded = requestedPath
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = expandPath(expanded)
  }
  const candidates = new Set<string>([expanded])

  if (isUncPath(expanded) && !isWslPath(expanded)) {
    return Array.from(candidates)
  }
  try {
    let current = expanded
    const seen = new Set<string>()
    for (let hop = 0; hop < 64; hop++) {
      if (seen.has(current)) break
      seen.add(current)
      let target: string | undefined
      let readlinkErrno: string | undefined
      try {
        target = readlinkSync(current)
      } catch (error) {
        readlinkErrno = (error as NodeJS.ErrnoException).code
      }
      if (target === undefined) {
        if (readlinkErrno === 'ENOENT' && current === expanded) {
          const resolved = resolveViaExistingAncestor(expanded)
          if (resolved !== undefined) candidates.add(resolved)
        }
        break
      }
      const next = isAbsolute(target)
        ? target
        : resolve(dirname(current), target)
      candidates.add(next)
      if (isUncPath(next) && !isWslPath(next)) {
        return Array.from(candidates)
      }
      current = next
    }
  } catch {
    // Fall through to the realpath attempt below.
  }
  try {
    const real = realpathSync(expanded)
    if (real !== expanded) candidates.add(real)
  } catch {
    // Nonexistent or unreadable — the expanded path is the only candidate.
  }
  return Array.from(candidates)
}

/**
 * Resolve a path whose leaf doesn't exist yet through its nearest existing
 * ancestor's realpath (Official 2.1.169 `t9H`, leaf-only form — /cd stats
 * the directory before this runs, so the ENOENT case is a backstop).
 */
function resolveViaExistingAncestor(path: string): string | undefined {
  const suffix: string[] = []
  let current = path
  while (true) {
    try {
      const real = realpathSync(current)
      return suffix.length === 0 ? real : join(real, ...suffix)
    } catch {
      // Keep walking up.
    }
    if (dirname(current) === current) return undefined
    suffix.unshift(basename(current))
    current = dirname(current)
  }
}
