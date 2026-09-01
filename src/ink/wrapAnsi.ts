import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

const wrapAnsiBun =
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
    ? Bun.wrapAnsi
    : null

const wrapAnsiImpl: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = wrapAnsiBun ?? wrapAnsiNpm

// Official 2.1.152 `Q55` / `Oj6` / `g55` / `d55` — 38/48 truecolor+256
// sequences lose their SGR on wrap-inserted newlines unless re-opened.
const TRUECOLOR_OR_256 = /\x1b\[[34]8;[25];/
const SGR = /\x1b\[([\d;]*)m/g
const ANSI16_FG = /^(3[0-79]|9[0-7])$/
const ANSI16_BG = /^(4[0-79]|10[0-7])$/

/** Official 2.1.152 `ddK`: close 38/48 at each newline, then re-open. */
function reapplyColorAfterNewline(
  chunk: string,
  fg: string,
  bg: string,
): string {
  if (chunk === '' || (fg === '' && bg === '')) return chunk
  let out = ''
  let start = 0
  for (let i = 0; i < chunk.length; i++) {
    if (chunk.charCodeAt(i) === 10) {
      out += chunk.slice(start, i)
      if (fg) out += '\x1B[39m'
      if (bg) out += '\x1B[49m'
      out += `\n${fg}${bg}`
      start = i + 1
    }
  }
  return out + chunk.slice(start)
}

/** Official 2.1.152 `c55`: track last 38;/48; SGR and re-apply after `\n`. */
function reapplyWrapColors(text: string): string {
  let out = ''
  let fg = ''
  let bg = ''
  let last = 0
  SGR.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SGR.exec(text)) !== null) {
    out += reapplyColorAfterNewline(text.slice(last, match.index), fg, bg)
    out += match[0]
    last = SGR.lastIndex
    const params = match[1] ?? ''
    if (params === '' || params === '0') {
      fg = ''
      bg = ''
    } else if (params.startsWith('38;')) {
      fg = match[0]
    } else if (ANSI16_FG.test(params)) {
      fg = ''
    } else if (params.startsWith('48;')) {
      bg = match[0]
    } else if (ANSI16_BG.test(params)) {
      bg = ''
    }
  }
  return out + reapplyColorAfterNewline(text.slice(last), fg, bg)
}

/**
 * Official 2.1.152 `qr`: wrapAnsi, then if the source had 38/48 color and
 * wrap inserted a newline, re-open that color on the continuation line.
 */
function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  if (!(columns > 0)) return input
  const wrapped = wrapAnsiImpl(input, columns, options)
  if (TRUECOLOR_OR_256.test(input) && wrapped.includes('\n')) {
    return reapplyWrapColors(wrapped)
  }
  return wrapped
}

export { wrapAnsi }
