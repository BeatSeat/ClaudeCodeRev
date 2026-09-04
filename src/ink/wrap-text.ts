import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import type { Styles } from './styles.js'
import { wrapAnsi } from './wrapAnsi.js'

const ELLIPSIS = '…'

// sliceAnsi may include a boundary-spanning wide char (e.g. CJK at position
// end-1 with width 2 overshoots by 1). Retry with a tighter bound once.
function sliceFit(text: string, start: number, end: number): string {
  const s = sliceAnsi(text, start, end)
  return stringWidth(s) > end - start ? sliceAnsi(text, start, end - 1) : s
}

function truncate(
  text: string,
  columns: number,
  position: 'start' | 'middle' | 'end',
): string {
  if (columns < 1) return ''
  if (columns === 1) return ELLIPSIS

  const length = stringWidth(text)
  if (length <= columns) return text

  if (position === 'start') {
    return ELLIPSIS + sliceFit(text, length - columns + 1, length)
  }
  if (position === 'middle') {
    const half = Math.floor(columns / 2)
    return (
      sliceFit(text, 0, half) +
      ELLIPSIS +
      sliceFit(text, length - (columns - half) + 1, length)
    )
  }
  return sliceFit(text, 0, columns - 1) + ELLIPSIS
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
): string {
  if (wrapType === 'wrap') {
    return wrapAnsi(text, maxWidth, {
      trim: false,
      hard: true,
    })
  }

  if (wrapType === 'wrap-trim') {
    return wrapAnsi(text, maxWidth, {
      trim: true,
      hard: true,
    })
  }

  if (wrapType!.startsWith('truncate')) {
    let position: 'end' | 'middle' | 'start' = 'end'

    if (wrapType === 'truncate-middle') {
      position = 'middle'
    }

    if (wrapType === 'truncate-start') {
      position = 'start'
    }

    return truncate(text, maxWidth, position)
  }

  return text
}

/**
 * Official 2.1.166 `kS8`: whether the character before `offset` is a newline
 * — or this is the first line of the text. Feeds the `isPrecededByNewline`
 * field of the official frozen-lines wrap model (`rp4`); that model and its
 * SearchBox consumer are not in-tree yet, kept verbatim for shape parity.
 */
export function isPrecededByNewline(
  text: string,
  offset: number,
  isFirstLine: boolean,
): boolean {
  if (isFirstLine) return true
  return offset > 0 && text[offset - 1] === '\n'
}

/** Official 2.1.166 `sp4`: clamp `value` into [min, max]. */
export function clampToRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
