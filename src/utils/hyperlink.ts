import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { fileURLToPath } from 'url'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { openBrowser, openPath } from './browser.js'
import { logForDebugging } from './debug.js'

/** Official 2.1.178 `Tw` / `jg6` — schemes `xW8` will dispatch. */
const HYPERLINK_ALLOWED_SCHEMES = new Set([
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

// OSC 8 hyperlink escape sequences
// Format: \e]8;;URL\e\\TEXT\e]8;;\e\\
// Using \x07 (BEL) as terminator which is more widely supported
export const OSC8_START = '\x1b]8;;'
export const OSC8_END = '\x07'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks)
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    // Official 2.1.128 `rB`: no-OSC-8 terminals keep the label, then the URL.
    if (content !== undefined) {
      const stripped = stripAnsi(content)
      if (
        stripped !== url &&
        url !== `http://${stripped}` &&
        url !== `https://${stripped}`
      ) {
        return `${content} (${url})`
      }
    }
    return url
  }

  // Apply basic ANSI blue color - wrap-ansi preserves this across line breaks
  // RGB colors (like theme colors) are NOT preserved by wrap-ansi with OSC 8
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  return `${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}

/**
 * Official 2.1.178 `xW8` — open a clicked OSC 8 URL. `file:` via
 * `fileURLToPath`+`openPath` (empty host only); other schemes must be
 * allowlisted or the click is refused and logged.
 */
export async function dispatchClickedHyperlink(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const scheme = parsed.protocol
  if (scheme === 'file:') {
    if (parsed.host !== '') return false
    try {
      return await openPath(fileURLToPath(url))
    } catch {
      return false
    }
  }
  if (!HYPERLINK_ALLOWED_SCHEMES.has(scheme)) {
    logForDebugging(
      `[hyperlink] refusing to dispatch clicked link with non-allowlisted scheme ${scheme}`,
      { level: 'warn' },
    )
    return false
  }
  return openBrowser(url)
}
