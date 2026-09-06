import { useMemo, useSyncExternalStore } from 'react'
import type { Color } from 'src/ink/styles.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { FooterLinkRegex } from 'src/utils/settings/types.js'
import { getSettingsFromUserFlagAndPolicy } from 'src/utils/settings/settings.js'
import type { Message } from 'src/types/message.js'
import { errorMessage } from 'src/utils/errors.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import type { Theme } from 'src/utils/theme.js'
import {
  extractTextContent,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  normalizeMessages,
} from 'src/utils/messages.js'
import stripAnsi from 'src/utils/stripAnsi.js'
import { truncateToWidth } from 'src/utils/truncate.js'

/** Official 176 footer-link badge (AppState `footerLinks` item). */
export type FooterLink = {
  url: string
  label: string
  dedupUrl?: string
  prefix?: string
  key?: string
  color?: keyof Theme | Color
}

/** Official 176 `zF$` — at most 5 badges render. */
const MAX_FOOTER_LINKS = 5
/** Official 176 `WN9` = zF$*4. Keep the last N matches per pattern. */
const MATCH_WINDOW = MAX_FOOTER_LINKS * 4
/** Official 176 `LN9` = WN9*10. Stop scanning a pattern past this many hits. */
const SCAN_CEILING = MATCH_WINDOW * 10
/** Official 176 `LAA`. */
const LABEL_WIDTH = 28
/** Official 176 `PN9`. */
const MAX_URL_CHARS = 2048
/** Official 176 `PAA`. */
const SLOW_PATTERN_MS = 50
/** Official 176 `TN9`. */
const EXTRACT_TAIL = 8192
/** Official 176 `K2q`. */
const SCAN_TEXT_CAP = 65536
/** Official 176 `SAA`. */
const MAX_ELIGIBLE_MESSAGES = 256

/** Official 176 `vN9`. */
const SYSTEM_REMINDER_PREFIX = `<system-reminder>\n`
/** Official 176 `KAq`. */
const MID_TURN_USER_PREFIX = `The user sent a new message while you were working:\n`

const TEMPLATE_PLACEHOLDER = /\{([^{}]+)\}/g
const NAMED_CAPTURE = /\(\?<([^>=!][^>]*)>/g
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g

/** Official 176 `yAA`. */
const ALLOWED_SCHEMES = new Set([
  'https:',
  'http:',
  'vscode:',
  'vscode-insiders:',
  'cursor:',
  'windsurf:',
  'zed:',
  'jetbrains:',
  'idea:',
  'slack:',
  'linear:',
  'notion:',
  'figma:',
])

function memoizeByFirstArg<A, R>(fn: (arg: A) => R): (arg: A) => R {
  const cache = new Map<A, R>()
  return (arg: A): R => {
    if (cache.has(arg)) {
      return cache.get(arg) as R
    }
    const result = fn(arg)
    cache.set(arg, result)
    return result
  }
}

/** Official 176 `dl$` fallback — replace unmatched surrogates (no `toWellFormed` in this TS lib). */
function toUsvString(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  )
}

/** Official 176 `VN9`. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Official 176 `GN9`. */
function urlOrigin(url: URL): string {
  return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`
}

/** Official 176 `WAA`. */
const warnUnreadableEntry = memoizeByFirstArg((types: string) => {
  logForDebugging(
    `[footerLinks] skipping a 'regex' entry with non-string fields (pattern/url/label types: ${types}); the entry is preserved in settings`,
    { level: 'warn' },
  )
})

/** Official 176 `GAA`. */
const warnMissingNamedGroups = memoizeByFirstArg((key: string) => {
  const sep = key.indexOf('\x00')
  const pattern = sep === -1 ? key : key.slice(0, sep)
  const rest = sep === -1 ? '' : key.slice(sep + 1)
  const sep2 = rest.indexOf('\x00')
  const url = sep2 === -1 ? rest : rest.slice(0, sep2)
  const label = sep2 === -1 ? '' : rest.slice(sep2 + 1)
  const named = new Set(
    [...pattern.matchAll(NAMED_CAPTURE)].map(match => match[1]),
  )
  const templates = `${url}\n${label}`
  for (const [, name] of templates.matchAll(TEMPLATE_PLACEHOLDER)) {
    if (name !== undefined && !named.has(name)) {
      logForDebugging(
        `[footerLinks] template references {${name}} but pattern ${pattern} has no such named capture group`,
        { level: 'warn' },
      )
    }
  }
})

/** Official 176 `hAA`. */
const compileUrlOrigin = memoizeByFirstArg((template: string): string | null => {
  const parsed = parseUrl(template.replace(TEMPLATE_PLACEHOLDER, 'x'))
  if (!parsed || !ALLOWED_SCHEMES.has(parsed.protocol)) {
    logForDebugging(
      `[footerLinks] url template "${template}" must have a literal origin with an allowlisted scheme (e.g. https://host/...); skipping`,
      { level: 'warn' },
    )
    return null
  }
  return urlOrigin(parsed)
})

/** Official 176 `EAA`. */
const compilePattern = memoizeByFirstArg((pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern, 'g')
  } catch (error) {
    logForDebugging(
      `[footerLinks] invalid pattern ${pattern}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return null
  }
})

/** Official 176 `TAA`. */
function expandUrlTemplate(
  template: string,
  groups: Record<string, string>,
): string | null {
  const expanded = template.replace(TEMPLATE_PLACEHOLDER, (_m, name: string) =>
    encodeURIComponent(
      toUsvString(Object.hasOwn(groups, name) ? (groups[name] ?? '') : ''),
    ),
  )
  const queryIdx = expanded.search(/[?#]/)
  const path = queryIdx === -1 ? expanded : expanded.slice(0, queryIdx)
  if (path.split(/[/\\]/).some(segment => DOT_SEGMENT.test(segment))) {
    return null
  }
  return expanded
}

/** Official 176 `kAA`. */
function sanitizeLabel(text: string): string {
  return stripAnsi(text).replace(CONTROL_CHARS, '')
}

/** Official 176 `NAA`. */
function expandLabelTemplate(
  template: string,
  groups: Record<string, string>,
): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (_m, name: string) =>
    Object.hasOwn(groups, name) ? (groups[name] ?? '') : '',
  )
}

/** Official 176 `gc8`. */
function footerLinksEqual(a: FooterLink, b: FooterLink): boolean {
  return (
    a.url === b.url ||
    a.url === b.dedupUrl ||
    a.dedupUrl === b.url ||
    (a.dedupUrl !== undefined && a.dedupUrl === b.dedupUrl)
  )
}

function partition<T>(items: T[], pred: (item: T) => boolean): [T[], T[]] {
  const matched: T[] = []
  const rest: T[] = []
  for (const item of items) {
    if (pred(item)) matched.push(item)
    else rest.push(item)
  }
  return [matched, rest]
}

function sameFooterLink(a: FooterLink, b: FooterLink | undefined): boolean {
  return (
    b !== undefined &&
    (a === b ||
      (a.url === b.url &&
        a.dedupUrl === b.dedupUrl &&
        a.label === b.label &&
        a.prefix === b.prefix &&
        a.key === b.key &&
        a.color === b.color))
  )
}

/** Official 176 `q2q`. */
export function mergeFooterLinks(
  existing: FooterLink[],
  incoming: FooterLink[],
): FooterLink[] {
  if (incoming.length === 0) return existing
  const [keyed, unkeyed] = partition(existing, link => link.key !== undefined)
  const added: FooterLink[] = []
  for (const link of incoming) {
    if (
      added.some(item => footerLinksEqual(item, link)) ||
      keyed.some(item => footerLinksEqual(item, link))
    ) {
      continue
    }
    added.push(link)
  }
  if (added.length === 0) return existing
  const keptUnkeyed = unkeyed.filter(
    link => !added.some(item => footerLinksEqual(item, link)),
  )
  const next = [
    ...keyed,
    ...[...added, ...keptUnkeyed].slice(0, MAX_FOOTER_LINKS),
  ]
  if (
    next.length === existing.length &&
    next.every((link, i) => sameFooterLink(link, existing[i]))
  ) {
    return existing
  }
  return next
}

/** Official 176 `$2q`. */
export function scanFooterLinkMatches(
  entries: FooterLinkRegex[],
  text: string,
): FooterLink[] {
  if (!entries || entries.length === 0 || !text) return []
  const matches: { index: number; match: FooterLink }[] = []
  for (const entry of entries) {
    if (entry.type !== 'regex') continue
    const pattern = 'pattern' in entry ? entry.pattern : undefined
    const url = 'url' in entry ? entry.url : undefined
    const label = 'label' in entry ? entry.label : undefined
    if (
      typeof pattern !== 'string' ||
      typeof url !== 'string' ||
      (label !== undefined && typeof label !== 'string')
    ) {
      warnUnreadableEntry(`${typeof pattern}/${typeof url}/${typeof label}`)
      continue
    }
    const compiled = compilePattern(pattern)
    if (!compiled) continue
    const origin = compileUrlOrigin(url)
    if (origin === null) continue
    warnMissingNamedGroups(`${pattern}\x00${url}\x00${label ?? ''}`)
    let hitCount = 0
    const window: RegExpExecArray[] = []
    let droppedOrigin = false
    let droppedLong = false
    let droppedEmpty = false
    const started = performance.now()
    try {
      for (const match of text.matchAll(compiled)) {
        if (++hitCount > SCAN_CEILING) {
          logForDebugging(
            `[footerLinks] pattern ${pattern} exceeded ${SCAN_CEILING} matches in one scan; stopping (newest matches beyond the ceiling are not collected)`,
            { level: 'warn' },
          )
          break
        }
        window.push(match)
        if (window.length > MATCH_WINDOW) window.shift()
      }
      for (const match of window) {
        const groups = (match.groups ?? {}) as Record<string, string>
        const expanded = expandUrlTemplate(url, groups)
        if (expanded !== null && expanded.length > MAX_URL_CHARS) {
          if (!droppedLong) {
            droppedLong = true
            logForDebugging(
              `[footerLinks] dropping over-length url (${expanded.length} > ${MAX_URL_CHARS} chars) for pattern ${pattern}`,
              { level: 'warn' },
            )
          }
          continue
        }
        const parsed = expanded === null ? null : parseUrl(expanded)
        if (expanded === null || !parsed || urlOrigin(parsed) !== origin) {
          if (!droppedOrigin) {
            droppedOrigin = true
            logForDebugging(
              `[footerLinks] dropping ${expanded === null ? 'dot-segment' : parsed ? 'origin-shifted' : 'unparseable'} url for pattern ${pattern}`,
              { level: 'warn' },
            )
          }
          continue
        }
        const labelText = typeof label === 'string' ? label : undefined
        const rawLabel = labelText
          ? expandLabelTemplate(labelText, groups)
          : (match[0] ?? '')
        const badge = truncateToWidth(sanitizeLabel(rawLabel.trim()), LABEL_WIDTH)
        if (badge === '') {
          if (!droppedEmpty) {
            droppedEmpty = true
            logForDebugging(
              `[footerLinks] dropping match with empty label for pattern ${pattern}`,
              { level: 'warn' },
            )
          }
          continue
        }
        matches.push({
          index: match.index ?? 0,
          match: { url: expanded, label: badge },
        })
      }
    } catch (error) {
      logForDebugging(
        `[footerLinks] regex exec failed for ${pattern}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
    const elapsed = performance.now() - started
    if (elapsed > SLOW_PATTERN_MS) {
      logForDebugging(
        `[footerLinks] slow pattern (${Math.round(elapsed)}ms): ${pattern}`,
        { level: 'warn' },
      )
    }
  }
  return matches.sort((a, b) => a.index - b.index).map(item => item.match)
}

/** Official 176 `kN9`. Schema is Services; UI reads policy+flag+user only. */
export function readFooterLinksRegexes(): FooterLinkRegex[] | undefined {
  const entries = getSettingsFromUserFlagAndPolicy('footerLinksRegexes').flat()
  return entries.length > 0 ? entries : undefined
}

/** Official 176 `_2q`. */
function capExtract(text: string): string {
  return text.length > EXTRACT_TAIL ? text.slice(-EXTRACT_TAIL) : text
}

/** Official 176 `E_$`. */
function isToolResultUserMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (typeof content === 'string') return false
  return content.some(block => block.type === 'tool_result')
}

/** Official 176 `bAA`. */
function isInterruptUserMessage(message: Message): boolean {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return false
  }
  const first = message.message.content[0]
  return (
    first?.type === 'text' &&
    (first.text === INTERRUPT_MESSAGE ||
      first.text === INTERRUPT_MESSAGE_FOR_TOOL_USE)
  )
}

/** Official 176 `xAA`. */
function isMidTurnUserMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content[0]?.type === 'text'
        ? content[0].text
        : ''
  const stripped = text.startsWith(SYSTEM_REMINDER_PREFIX)
    ? text.slice(SYSTEM_REMINDER_PREFIX.length)
    : text
  return stripped.startsWith(MID_TURN_USER_PREFIX)
}

/** Official 176 `IAA`. */
function isEligibleFooterLinkMessage(message: Message): boolean {
  if (message.type === 'assistant') {
    return (
      Array.isArray(message.message.content) &&
      message.message.content.some(block => block.type === 'text')
    )
  }
  if (message.type === 'user') {
    if (message.isMeta || !Array.isArray(message.message.content)) return false
    return message.message.content.some(block => {
      if (block.type !== 'tool_result') return false
      const content = 'content' in block ? block.content : undefined
      return (
        typeof content === 'string' ||
        (Array.isArray(content) && content.some(part => part.type === 'text'))
      )
    })
  }
  return false
}

/** Official 176 `uAA`. */
function extractScanText(message: Message): string {
  if (message.type === 'assistant') {
    const first = message.message.content[0]
    return first?.type === 'text' ? capExtract(first.text) : ''
  }
  if (message.type === 'user') {
    if (message.isMeta) return ''
    const first = Array.isArray(message.message.content)
      ? message.message.content[0]
      : undefined
    if (!first || first.type !== 'tool_result') return ''
    const content = 'content' in first ? first.content : undefined
    if (typeof content === 'string') return capExtract(content)
    if (Array.isArray(content)) {
      return capExtract(extractTextContent(content, '\n'))
    }
    return ''
  }
  return ''
}

/** Official 176 `hN9`. */
export function collectFooterLinkScanText(messages: Message[]): string {
  let text = ''
  let eligible = 0
  for (
    let i = messages.length - 1;
    i >= 0 && text.length < SCAN_TEXT_CAP && eligible < MAX_ELIGIBLE_MESSAGES;
    i--
  ) {
    const message = messages[i]
    if (!message || !isEligibleFooterLinkMessage(message)) continue
    eligible++
    const parts: string[] = []
    for (const normalized of normalizeMessages([message])) {
      const extracted = extractScanText(normalized)
      if (extracted) parts.push(extracted)
    }
    if (parts.length > 0) {
      const chunk = parts.join('\n')
      text = text ? `${chunk}\n${text}` : chunk
    }
  }
  return text.length > SCAN_TEXT_CAP ? text.slice(-SCAN_TEXT_CAP) : text
}

/** Official 176 `CAA`. */
export function sliceAfterLastUserPrompt(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !isToolResultUserMessage(message) &&
      !isInterruptUserMessage(message) &&
      !isMidTurnUserMessage(message)
    ) {
      return messages.slice(i + 1)
    }
  }
  return messages.slice()
}

/** Official 176 `RAA`. */
export function rehydrateFooterLinkScan(
  messages: Message[],
  entries: FooterLinkRegex[],
  existing: FooterLink[] = [],
): FooterLink[] {
  if (!entries || entries.length === 0) return existing
  const text = collectFooterLinkScanText(messages)
  if (!text) return existing
  return mergeFooterLinks(
    existing,
    scanFooterLinkMatches(entries, text).reverse(),
  )
}

let footerLinksStore: FooterLink[] = []
const footerLinkListeners = new Set<() => void>()

function emitFooterLinks(): void {
  for (const listener of footerLinkListeners) listener()
}

function setFooterLinksStore(next: FooterLink[]): void {
  if (next === footerLinksStore) return
  footerLinksStore = next
  emitFooterLinks()
}

function subscribeFooterLinks(listener: () => void): () => void {
  footerLinkListeners.add(listener)
  return () => {
    footerLinkListeners.delete(listener)
  }
}

function getFooterLinksSnapshot(): FooterLink[] {
  return footerLinksStore
}

/** Official 176 `ZN9` — keyed upsert (PR badge uses `"current-pr"`). */
export function upsertKeyedFooterLink(
  links: FooterLink[],
  key: string,
  value: FooterLink | null,
): FooterLink[] {
  const existing = links.find(link => link.key === key)
  if (value === null) {
    return existing ? links.filter(link => link.key !== key) : links
  }
  if (
    existing &&
    existing.url === value.url &&
    existing.dedupUrl === value.dedupUrl &&
    existing.label === value.label &&
    existing.prefix === value.prefix &&
    existing.color === value.color
  ) {
    return links
  }
  return [
    { ...value, key },
    ...links.filter(
      link => link.key !== key && (link.key !== undefined || !footerLinksEqual(link, value)),
    ),
  ]
}

/** Official 176 `yN9`. */
export function scanFooterLinksAfterTurn(messages: Message[]): void {
  try {
    const entries = readFooterLinksRegexes()
    if (!entries || entries.length === 0) return
    const text = collectFooterLinkScanText(sliceAfterLastUserPrompt(messages))
    const incoming = text ? scanFooterLinkMatches(entries, text).reverse() : []
    if (incoming.length === 0) return
    logEvent('repl_footer_links', {})
    const next = mergeFooterLinks(footerLinksStore, incoming)
    setFooterLinksStore(next)
  } catch (error) {
    logError(error)
  }
}

/**
 * Official 176 `NN9`/`RAA` without the session-rehydrator API (`XN9`).
 * Scan the in-memory transcript once after resume/mount.
 */
export function rehydrateFooterLinks(messages: Message[]): void {
  const entries = readFooterLinksRegexes()
  const keyed = footerLinksStore.filter(link => link.key !== undefined)
  const next =
    !entries || entries.length === 0
      ? keyed
      : rehydrateFooterLinkScan(messages, entries, keyed)
  setFooterLinksStore(next)
}

/** Official `/clear` keeps keyed badges (`footerLinks.filter(V => V.key !== void 0)`). */
export function retainKeyedFooterLinks(): void {
  const next = footerLinksStore.filter(link => link.key !== undefined)
  setFooterLinksStore(next)
}

/** Official 176 `ZC9`. */
export function useFooterLinks(options?: { excludeKeyed?: boolean }): FooterLink[] {
  const links = useSyncExternalStore(
    subscribeFooterLinks,
    getFooterLinksSnapshot,
    getFooterLinksSnapshot,
  )
  const excludeKeyed = options?.excludeKeyed === true
  return useMemo(() => {
    const filtered = excludeKeyed
      ? links.filter(link => link.key === undefined)
      : links
    return filtered.length <= MAX_FOOTER_LINKS
      ? filtered
      : filtered.slice(0, MAX_FOOTER_LINKS)
  }, [links, excludeKeyed])
}
