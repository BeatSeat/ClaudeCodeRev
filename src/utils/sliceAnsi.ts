import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '../ink/stringWidth.js'

// A code is an "end code" if its code equals its endCode (e.g., hyperlink close)
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

// Filter to only include "start codes" (not end codes)
function filterStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter(c => !isEndCode(c))
}

/**
 * Slice a string containing ANSI escape codes.
 *
 * Unlike the slice-ansi package, this properly handles OSC 8 hyperlink
 * sequences because @alcalzone/ansi-tokenize tokenizes them correctly.
 */
const OSC8_ST = '\x1b\\'
const OSC8_BEL = '\x07'

/**
 * Official wL_: rewrite OSC 8 hyperlinks that end with ST (`ESC \`) to BEL
 * so the tokenizer does not leak the ST bytes into copied bash output.
 */
function rewriteOsc8StToBel(str: string): string {
  let out = ''
  let i = 0
  while (i < str.length) {
    const start = str.indexOf('\x1b]8;', i)
    if (start === -1) {
      return out + str.slice(i)
    }
    out += str.slice(i, start)
    const after = start + 4
    const st = str.indexOf(OSC8_ST, after)
    const bel = str.indexOf(OSC8_BEL, after)
    if (st !== -1 && (bel === -1 || st < bel)) {
      out += str.slice(start, st) + OSC8_BEL
      i = st + OSC8_ST.length
    } else if (bel !== -1) {
      out += str.slice(start, bel + 1)
      i = bel + 1
    } else {
      return out + str.slice(start)
    }
  }
  return out
}

export default function sliceAnsi(
  str: string,
  start: number,
  end?: number,
): string {
  // Don't pass `end` to tokenize — it counts code units, not display cells,
  // so it drops tokens early for text with zero-width combining marks.
  const tokens = tokenize(rewriteOsc8StToBel(str))
  let activeCodes: AnsiCode[] = []
  let position = 0
  let result = ''
  let include = false

  for (const token of tokens) {
    // Advance by display width, not code units. Combining marks (Devanagari
    // matras, virama, diacritics) are width 0 — counting them via .length
    // advanced position past `end` early and truncated the slice. Callers
    // pass start/end in display cells (via stringWidth), so position must
    // track the same units.
    const width =
      token.type === 'ansi' ? 0 : token.fullWidth ? 2 : stringWidth(token.value)

    // Break AFTER trailing zero-width marks — a combining mark attaches to
    // the preceding base char, so "भा" (भ + ा, 1 display cell) sliced at
    // end=1 must include the ा. Breaking on position >= end BEFORE the
    // zero-width check would drop it and render भ bare. ANSI codes are
    // width 0 but must NOT be included past end (they open new style runs
    // that leak into the undo sequence), so gate on char type too. The
    // !include guard ensures empty slices (start===end) stay empty even
    // when the string starts with a zero-width char (BOM, ZWJ).
    if (end !== undefined && position >= end) {
      if (token.type === 'ansi' || width > 0 || !include) break
    }

    if (token.type === 'ansi') {
      activeCodes.push(token)
      if (include) {
        // Emit all ANSI codes during the slice
        result += token.code
      }
    } else {
      if (!include && position >= start) {
        // Skip leading zero-width marks at the start boundary — they belong
        // to the preceding base char in the left half. Without this, the
        // mark appears in BOTH halves: left+right ≠ original. Only applies
        // when start > 0 (otherwise there's no preceding char to own it).
        if (start > 0 && width === 0) continue
        include = true
        // Reduce and filter to only active start codes
        activeCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
        result = ansiCodesToString(activeCodes)
      }

      if (include) {
        result += token.value
      }

      position += width
    }
  }

  // Only undo start codes that are still active
  const activeStartCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes))
  return result
}
