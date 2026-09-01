import type {
  CommandUnknownOpts,
  Help,
} from '@commander-js/extra-typings'
import { stringWidth } from '../ink/stringWidth.js'

/** Official 2.1.153 `oy$`. */
const HELP_ITEM_INDENT = 2
/** Official 2.1.153 `ay$`. */
const HELP_TERM_DESC_GAP = 2
/** Official 2.1.153 `JXz`. */
const HELP_TERM_PAD_CAP = 36
/** Official 2.1.153 `XXz`. */
const HELP_WRAP_MIN_REMAINDER = 30
/** Official 2.1.153 `L69`. */
const HELP_OVERFLOW_INDENT = 4

/**
 * Official 2.1.153 `OKq` — wrap on whitespace tokens, preserve existing
 * newlines. Overflowing tokens drop leading whitespace on the next line.
 */
export function wrapHelpText(text: string, width: number): string {
  const maxWidth = Math.max(width, 1)
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const tokens = rawLine.match(/\s*\S+/g)
    if (!tokens) {
      lines.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    let started = false
    for (const token of tokens) {
      const tokenWidth = stringWidth(token)
      if (!started) {
        current = token
        currentWidth = tokenWidth
        started = true
      } else if (currentWidth + tokenWidth <= maxWidth) {
        current += token
        currentWidth += tokenWidth
      } else {
        lines.push(current)
        const trimmed = token.replace(/^\s+/, '')
        current = trimmed
        currentWidth = stringWidth(trimmed)
      }
    }
    lines.push(current)
  }
  return lines.join('\n')
}

/**
 * Official 2.1.153 `Rh8` — pad term to `termWidth`, wrap description when the
 * remainder is at least `XXz=30`, otherwise break onto the next line with
 * `L69=4` extra indent.
 */
export function formatHelpItem(
  term: string,
  description: string,
  termWidth: number,
  helpWidth: number,
): string {
  const indent = ' '.repeat(HELP_ITEM_INDENT)
  if (!description) {
    return indent + term
  }
  const termDisplayWidth = stringWidth(term)
  if (description.includes('\n')) {
    const gap =
      termDisplayWidth <= termWidth
        ? ' '.repeat(termWidth - termDisplayWidth + HELP_TERM_DESC_GAP)
        : ' '.repeat(HELP_TERM_DESC_GAP)
    return (indent + term + gap + description).replace(/\n/g, `\n${indent}`)
  }
  const remainder =
    helpWidth - HELP_ITEM_INDENT - termWidth - HELP_TERM_DESC_GAP
  if (termDisplayWidth <= termWidth && remainder >= HELP_WRAP_MIN_REMAINDER) {
    const gap = ' '.repeat(termWidth - termDisplayWidth + HELP_TERM_DESC_GAP)
    const wrapIndent = ' '.repeat(
      HELP_ITEM_INDENT + termWidth + HELP_TERM_DESC_GAP,
    )
    const wrapped = wrapHelpText(description, remainder)
    return indent + term + gap + wrapped.replace(/\n/g, `\n${wrapIndent}`)
  }
  const overflowIndent = ' '.repeat(HELP_ITEM_INDENT + HELP_OVERFLOW_INDENT)
  const overflowWidth = helpWidth - HELP_ITEM_INDENT - HELP_OVERFLOW_INDENT
  const wrapped = wrapHelpText(description, overflowWidth)
  return (
    indent +
    term +
    '\n' +
    overflowIndent +
    wrapped.replace(/\n/g, `\n${overflowIndent}`)
  )
}

/** Official 2.1.153 `Ih8`. */
function appendHelpSection(
  lines: string[],
  title: string,
  items: string[],
): void {
  if (items.length === 0) {
    return
  }
  lines.push(title, ...items, '')
}

/**
 * Official 2.1.153 `LXz` — commander `formatHelp`. Caps term pad at `JXz=36`
 * and wraps descriptions via `OKq`.
 */
export function formatHelp(
  cmd: CommandUnknownOpts,
  helper: Help,
): string {
  const helpWidth = helper.helpWidth || 80
  const termWidth = Math.min(helper.padWidth(cmd, helper), HELP_TERM_PAD_CAP)
  const lines = [`Usage: ${helper.commandUsage(cmd)}`, '']
  const description = helper.commandDescription(cmd)
  if (description.length > 0) {
    lines.push(wrapHelpText(description, helpWidth), '')
  }
  appendHelpSection(
    lines,
    'Arguments:',
    helper
      .visibleArguments(cmd)
      .map(argument =>
        formatHelpItem(
          helper.argumentTerm(argument),
          helper.argumentDescription(argument),
          termWidth,
          helpWidth,
        ),
      ),
  )
  appendHelpSection(
    lines,
    'Options:',
    helper
      .visibleOptions(cmd)
      .map(option =>
        formatHelpItem(
          helper.optionTerm(option),
          helper.optionDescription(option),
          termWidth,
          helpWidth,
        ),
      ),
  )
  if (helper.showGlobalOptions) {
    appendHelpSection(
      lines,
      'Global Options:',
      helper
        .visibleGlobalOptions(cmd)
        .map(option =>
          formatHelpItem(
            helper.optionTerm(option),
            helper.optionDescription(option),
            termWidth,
            helpWidth,
          ),
        ),
    )
  }
  appendHelpSection(
    lines,
    'Commands:',
    helper
      .visibleCommands(cmd)
      .map(command =>
        formatHelpItem(
          helper.subcommandTerm(command),
          helper.subcommandDescription(command),
          termWidth,
          helpWidth,
        ),
      ),
  )
  return lines.join('\n')
}
