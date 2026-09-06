/**
 * Official 2.1.172 (G2 — tengu_cobalt_plinth / artifact-publish): the
 * artifact URL / title helpers. These are the tree-side equivalents of the
 * bundle's `qPH` module (minified `tM8`), a net-new product block in the
 * 2.1.170 → 2.1.172 hop (astdiff added-product).
 *
 * Minified → readable map (the "title/url" half of the 13 added functions):
 *   oM8 → parseArtifactUrl     (parse a claude.ai / claudeusercontent URL)
 *   aM8 → extractHtmlTitle     (pull <title> out of the first 8KB of HTML)
 *   sM8 → sanitizeArtifactTitle (strip control chars, collapse ws, cap at 280)
 *   PKH → uuidSlugFromUrl      (slug-only variant of parseArtifactUrl)
 *
 * The same block also adds `tsH` → ArtifactInputError plus the
 * `TITLE_SCAN_BYTES` / `ARTIFACT_TOOL_NAME` exports alongside these.
 */

// `EC6` — the UUID slug pattern every artifact/frame URL is built from.
const ARTIFACT_SLUG_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

// `u27` — how many characters of HTML to scan for the <title> tag.
const TITLE_EXTRACT_CHARS = 8192

// `SC6` (exported as TITLE_SCAN_BYTES) — how many bytes to read from the file
// on disk before running the title scan (4× the char scan for multibyte).
export const TITLE_SCAN_BYTES = TITLE_EXTRACT_CHARS * 4

// `x27` — max length of a sanitized title.
const MAX_TITLE_LENGTH = 280

// `r75` — HTML numeric/named entity matcher.
const HTML_ENTITY_REGEX = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi

// `o75` — the named entities we resolve; numeric entities are decoded
// separately by code-point.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\xA0',
}

// `tsH` — raised when the artifact tool input is structurally invalid.
export class ArtifactInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactInputError'
  }
}

// `uAH` — the model-facing tool name.
export const ARTIFACT_TOOL_NAME = 'Artifact'

export type ParsedArtifactUrl = {
  slug: string
  env: 'prod' | 'staging'
}

/**
 * Official 2.1.172 `oM8` — parse an artifact URL into its slug + env.
 *
 * Recognized shapes (prod):
 *   https://[sub.]claude.ai/code/(artifact|frame)/<uuid>
 * Staging:
 *   https://[preview.]claude-ai.staging.ant.dev/code/(artifact|frame)/<uuid>
 *   https://<uuid>.frame.(staging.)claudeusercontent.com
 */
export function parseArtifactUrl(url: string): ParsedArtifactUrl | null {
  const prod = url.match(
    new RegExp(
      `^https://(?:[a-z0-9-]+\\.)?claude\\.ai/code/(?:artifact|frame)/(${ARTIFACT_SLUG_PATTERN})(?:[/?#]|$)`,
    ),
  )
  if (prod?.[1]) {
    return { slug: prod[1], env: 'prod' }
  }
  const staging = url.match(
    new RegExp(
      `^https://(?:preview\\.)?claude-ai\\.staging\\.ant\\.dev/code/(?:artifact|frame)/(${ARTIFACT_SLUG_PATTERN})(?:[/?#]|$)`,
    ),
  )
  if (staging?.[1]) {
    return { slug: staging[1], env: 'staging' }
  }
  const userContent = url.match(
    new RegExp(
      `^https://(${ARTIFACT_SLUG_PATTERN})\\.frame\\.(staging\\.)?claudeusercontent\\.com(?:[/?#]|$)`,
    ),
  )
  if (userContent?.[1]) {
    return { slug: userContent[1], env: userContent[2] ? 'staging' : 'prod' }
  }
  return null
}

/** Official 2.1.172 `PKH` — slug-only convenience wrapper over parseArtifactUrl. */
export function uuidSlugFromUrl(url: string): string | null {
  return parseArtifactUrl(url)?.slug ?? null
}

/**
 * Official 2.1.172 `aM8` — extract the <title> from the first 8KB of an HTML
 * string. Strips comments, drops everything from the first <svg> onward,
 * decodes numeric + named entities, then runs sanitizeArtifactTitle.
 */
export function extractHtmlTitle(html: string): string | null {
  let head = html
    .slice(0, TITLE_EXTRACT_CHARS)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  const svgIndex = head.search(/<svg/i)
  if (svgIndex !== -1) {
    head = head.slice(0, svgIndex)
  }
  const rawTitle = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  if (rawTitle === undefined) {
    return null
  }
  const decoded = rawTitle.replace(HTML_ENTITY_REGEX, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const codePoint = isHex
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10)
      // Reject surrogate half-code-points and out-of-range values.
      if (codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) {
        return String.fromCodePoint(codePoint)
      }
      return match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
  return sanitizeArtifactTitle(decoded)
}

/**
 * Official 2.1.172 `sM8` — strip C0 control chars and C1 controls (U+007F–
 * U+009F), collapse runs of whitespace, and cap the result at 280 chars.
 * Returns null for an empty title.
 */
export function sanitizeArtifactTitle(title: string): string | null {
  const scrubbed = Array.from(title, char => {
    const codePoint = char.codePointAt(0) ?? 0
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : char
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  if (scrubbed === '') {
    return null
  }
  const codePoints = Array.from(scrubbed)
  return codePoints.length > MAX_TITLE_LENGTH
    ? codePoints.slice(0, MAX_TITLE_LENGTH).join('')
    : scrubbed
}
