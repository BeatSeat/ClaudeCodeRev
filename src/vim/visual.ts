import { getGraphemeSegmenter, lastGrapheme } from '../utils/intl.js'
import { countCharInString } from '../utils/stringUtils.js'
import { findTextObject } from './textObjects.js'
import {
  FIND_KEYS,
  isOperatorKey,
  isTextObjScopeKey,
  MAX_VIM_COUNT,
  OPERATORS,
  SIMPLE_MOTIONS,
  TEXT_OBJ_SCOPES,
  TEXT_OBJ_TYPES,
  type FindType,
  type Operator,
  type VisualCommandState,
} from './types.js'
import type { OperatorContext } from './operators.js'
import { resolveMotion } from './motions.js'

export type VisualKind = 'char' | 'line'

export type VisualTransitionContext = OperatorContext & {
  onUndo?: () => void
  onDotRepeat?: () => void
}

export type VisualTransitionResult =
  | { next: VisualCommandState; move?: () => void }
  | { exit: 'operator'; op: Operator; forceLinewise?: boolean }
  | { exit: 'replace'; char: string }
  | { exit: 'case'; op: 'toggle' | 'lower' | 'upper' }
  | { exit: 'paste' }
  | { exit: 'join' }
  | { exit: 'indent'; dir: '>' | '<'; count: number }
  | { exit: 'swap' }
  | { exit: 'selectRange'; start: number; end: number }
  | { exit: 'toggleKind'; key: string }

/** Official 2.1.118 t_8 */
export function visualRange(
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): { from: number; to: number } {
  const from = Math.min(anchor, ctx.cursor.offset)
  const to = Math.max(anchor, ctx.cursor.offset)
  if (!linewise) {
    return { from, to: ctx.cursor.measuredText.nextOffset(to) }
  }
  const text = ctx.text
  const lineStart = lineStartOffset(text, from)
  const nl = text.indexOf('\n', to)
  return { from: lineStart, to: nl === -1 ? text.length : nl + 1 }
}

/** Official 2.1.118 s_8 */
export function visualSpan(text: string, linewise: boolean): number {
  if (linewise) {
    const n = countCharInString(text, '\n')
    return text.endsWith('\n') ? n : n + 1
  }
  return [...getGraphemeSegmenter().segment(text)].length
}

/** Official 2.1.118 c3$ — expand a recorded span from the current cursor. */
export function spanToRange(
  ctx: OperatorContext,
  span: number,
  linewise: boolean,
): { from: number; to: number } {
  const text = ctx.text
  if (linewise) {
    const from = lineStartOffset(text, ctx.cursor.offset)
    let to = from
    for (let i = 0; i < span; i++) {
      const nl = text.indexOf('\n', to)
      if (nl === -1) {
        to = text.length
        break
      }
      to = nl + 1
    }
    return { from, to }
  }
  let to = ctx.cursor.offset
  for (let i = 0; i < span && to < text.length; i++) {
    to = ctx.cursor.measuredText.nextOffset(to)
  }
  return { from: ctx.cursor.offset, to }
}

function lineStartOffset(text: string, offset: number): number {
  if (offset === 0) return 0
  const nl = text.lastIndexOf('\n', offset - 1)
  return nl === -1 ? 0 : nl + 1
}

function lineIndex(text: string, offset: number): number {
  return countCharInString(text.slice(0, offset), '\n')
}

function lineStartOfIndex(lines: string[], index: number): number {
  return lines.slice(0, index).join('\n').length + (index > 0 ? 1 : 0)
}

/** Official 2.1.118 x74 */
export function applyVisualOperator(
  op: Operator,
  from: number,
  to: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  if (linewise && op === 'change') {
    let content = ctx.text.slice(from, to)
    if (!content.endsWith('\n')) content += '\n'
    ctx.setRegister(content, true)
    const after = ctx.text.slice(to)
    ctx.setText(ctx.text.slice(0, from) + (after !== '' ? '\n' : '') + after)
    ctx.enterInsert(from)
    return
  }
  if (linewise && op === 'delete') {
    let content = ctx.text.slice(from, to)
    if (!content.endsWith('\n')) content += '\n'
    ctx.setRegister(content, true)
    let start = from
    if (to === ctx.text.length && from > 0 && ctx.text[from - 1] === '\n') {
      start -= 1
    }
    const newText = ctx.text.slice(0, start) + ctx.text.slice(to)
    ctx.setText(newText)
    const maxOff = Math.max(
      0,
      newText.length - (lastGrapheme(newText).length || 1),
    )
    ctx.setOffset(Math.min(start, maxOff))
    return
  }

  let content = ctx.text.slice(from, to)
  if (linewise && !content.endsWith('\n')) content += '\n'
  ctx.setRegister(content, linewise)
  if (op === 'yank') {
    ctx.setOffset(from)
    return
  }
  const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
  ctx.setText(newText)
  if (op === 'change') {
    ctx.enterInsert(from)
  } else {
    const maxOff = Math.max(
      0,
      newText.length - (lastGrapheme(newText).length || 1),
    )
    ctx.setOffset(Math.min(from, maxOff))
  }
}

/** Official 2.1.118 u74 */
export function executeVisualOperator(
  op: Operator,
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const { from, to } = visualRange(anchor, ctx, linewise)
  const span = visualSpan(ctx.text.slice(from, to), linewise)
  applyVisualOperator(op, from, to, ctx, linewise)
  if (op !== 'yank') {
    ctx.recordChange({ type: 'visualOp', op, span, linewise })
  }
}

/** Official 2.1.118 m74 */
export function replayVisualOperator(
  op: Operator,
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const { from, to } = spanToRange(ctx, span, linewise)
  if (from === to) return
  applyVisualOperator(op, from, to, ctx, linewise)
}

/** Official 2.1.118 B74 / F74 */
export function executeVisualReplace(
  char: string,
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const { from, to } = visualRange(anchor, ctx, linewise)
  const span = visualSpan(ctx.text.slice(from, to), linewise)
  replaceRange(char, from, to, ctx)
  ctx.recordChange({ type: 'visualReplace', char, span, linewise })
}

export function replayVisualReplace(
  char: string,
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const { from, to } = spanToRange(ctx, span, linewise)
  if (from === to) return
  replaceRange(char, from, to, ctx)
}

function replaceRange(
  char: string,
  from: number,
  to: number,
  ctx: OperatorContext,
): void {
  const slice = ctx.text.slice(from, to)
  let out = ''
  for (const { segment } of getGraphemeSegmenter().segment(slice)) {
    out += segment === '\n' ? '\n' : char
  }
  ctx.setText(ctx.text.slice(0, from) + out + ctx.text.slice(to))
  ctx.setOffset(from)
}

/** Official 2.1.118 d74 */
export function executeVisualCase(
  caseOp: 'toggle' | 'lower' | 'upper',
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const { from, to } = visualRange(anchor, ctx, linewise)
  const span = visualSpan(ctx.text.slice(from, to), linewise)
  applyCase(caseOp, from, to, ctx)
  ctx.recordChange({ type: 'visualCase', caseOp, span, linewise })
}

export function replayVisualCase(
  caseOp: 'toggle' | 'lower' | 'upper',
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const { from, to } = spanToRange(ctx, span, linewise)
  if (from === to) return
  applyCase(caseOp, from, to, ctx)
}

function applyCase(
  caseOp: 'toggle' | 'lower' | 'upper',
  from: number,
  to: number,
  ctx: OperatorContext,
): void {
  const slice = ctx.text.slice(from, to)
  let out = ''
  for (const { segment } of getGraphemeSegmenter().segment(slice)) {
    if (caseOp === 'upper') out += segment.toUpperCase()
    else if (caseOp === 'lower') out += segment.toLowerCase()
    else
      out +=
        segment === segment.toUpperCase()
          ? segment.toLowerCase()
          : segment.toUpperCase()
  }
  ctx.setText(ctx.text.slice(0, from) + out + ctx.text.slice(to))
  ctx.setOffset(from)
}

/** Official 2.1.118 c74 */
export function executeVisualPaste(
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const register = ctx.getRegister()
  if (!register) return
  const { from, to } = visualRange(anchor, ctx, linewise)
  const span = visualSpan(ctx.text.slice(from, to), linewise)
  const content = pasteOver(register, from, to, ctx, linewise)
  ctx.recordChange({ type: 'visualPaste', content, span, linewise })
}

export function replayVisualPaste(
  content: string,
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const { from, to } = spanToRange(ctx, span, linewise)
  if (from === to && !linewise) return
  pasteOver(content, from, to, ctx, linewise)
}

function pasteOver(
  register: string,
  from: number,
  to: number,
  ctx: OperatorContext,
  linewise: boolean,
): string {
  const sliceEndsNl = ctx.text.slice(from, to).endsWith('\n')
  let insert = register.endsWith('\n') ? register.slice(0, -1) : register
  if (sliceEndsNl && !insert.endsWith('\n')) insert += '\n'
  let yanked = ctx.text.slice(from, to)
  if (linewise && !yanked.endsWith('\n')) yanked += '\n'
  ctx.setRegister(yanked, linewise)
  const next = ctx.text.slice(0, from) + insert + ctx.text.slice(to)
  ctx.setText(next)
  if (linewise || insert.endsWith('\n')) {
    ctx.setOffset(from)
  } else {
    const last = lastGrapheme(insert)
    ctx.setOffset(Math.max(from, from + insert.length - (last.length || 1)))
  }
  return insert
}

/** Official 2.1.118 R74 */
export function executeVisualJoin(
  anchor: number,
  ctx: OperatorContext,
): void {
  const from = Math.min(anchor, ctx.cursor.offset)
  const to = Math.max(anchor, ctx.cursor.offset)
  const text = ctx.text
  const startLine = lineIndex(text, from)
  const lineCount = countCharInString(text.slice(from, to), '\n') + 1
  const lines = text.split('\n')
  const joinN = Math.max(1, Math.min(lineCount - 1, lines.length - startLine - 1))
  if (startLine >= lines.length - 1) return
  let joined = lines[startLine] ?? ''
  const cursorCol = joined.length
  for (let i = 1; i <= joinN; i++) {
    const next = (lines[startLine + i] ?? '').trimStart()
    if (next.length > 0) {
      if (!joined.endsWith(' ') && joined.length > 0) joined += ' '
      joined += next
    }
  }
  const nextLines = [
    ...lines.slice(0, startLine),
    joined,
    ...lines.slice(startLine + joinN + 1),
  ]
  ctx.setText(nextLines.join('\n'))
  ctx.setOffset(lineStartOfIndex(nextLines, startLine) + cursorCol)
  ctx.recordChange({ type: 'join', count: joinN })
}

/** Official 2.1.118 f06 / C74 */
function indentLines(
  lines: string[],
  from: number,
  to: number,
  dir: '>' | '<',
): void {
  for (let i = from; i <= to; i++) {
    const line = lines[i] ?? ''
    if (dir === '>') {
      lines[i] = '  ' + line
    } else if (line.startsWith('  ')) {
      lines[i] = line.slice(2)
    } else if (line.startsWith('\t')) {
      lines[i] = line.slice(1)
    } else {
      let n = 0
      while (n < line.length && n < 2 && /\s/.test(line[n]!)) n++
      lines[i] = line.slice(n)
    }
  }
}

export function executeVisualIndent(
  dir: '>' | '<',
  count: number,
  anchor: number,
  ctx: OperatorContext,
): void {
  const from = Math.min(anchor, ctx.cursor.offset)
  const to = Math.max(anchor, ctx.cursor.offset)
  const text = ctx.text
  const startLine = lineIndex(text, from)
  const endLine = startLine + countCharInString(text.slice(from, to), '\n')
  const lines = text.split('\n')
  for (let i = 0; i < count; i++) indentLines(lines, startLine, endLine, dir)
  const next = lines.join('\n')
  const indent = (lines[startLine] ?? '').match(/^\s*/)?.[0]?.length ?? 0
  ctx.setText(next)
  ctx.setOffset(lineStartOfIndex(lines, startLine) + indent)
  ctx.recordChange({
    type: 'visualIndent',
    dir,
    count,
    lines: endLine - startLine + 1,
  })
}

export function replayVisualIndent(
  dir: '>' | '<',
  count: number,
  lines: number,
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const all = text.split('\n')
  const startLine = lineIndex(text, ctx.cursor.offset)
  const endLine = Math.min(startLine + lines - 1, all.length - 1)
  for (let i = 0; i < count; i++) indentLines(all, startLine, endLine, dir)
  const next = all.join('\n')
  const indent = (all[startLine] ?? '').match(/^\s*/)?.[0]?.length ?? 0
  ctx.setText(next)
  ctx.setOffset(lineStartOfIndex(all, startLine) + indent)
}

/** Official 2.1.118 p74 */
export function replayVisualChange(
  span: number,
  linewise: boolean,
  text: string,
  ctx: OperatorContext,
): void {
  const { from, to } = spanToRange(ctx, span, linewise)
  if (from === to && !linewise) return
  let yanked = ctx.text.slice(from, to)
  if (linewise && !yanked.endsWith('\n')) yanked += '\n'
  ctx.setRegister(yanked, linewise)
  const after = ctx.text.slice(to)
  const suffix = linewise && after !== '' ? '\n' + after : after
  const next = ctx.text.slice(0, from) + text + suffix
  ctx.setText(next)
  const last = lastGrapheme(text)
  ctx.setOffset(Math.max(from, from + text.length - (last.length || 1)))
}

function visualMotion(
  key: string,
  cursor: OperatorContext['cursor'],
  count: number,
): number {
  return resolveMotion(key, cursor, count).offset
}

/** Official 2.1.118 $44 */
function visualCommand(
  key: string,
  count: number,
  ctx: VisualTransitionContext,
): VisualTransitionResult | null {
  if (isOperatorKey(key)) {
    return { exit: 'operator', op: OPERATORS[key] }
  }
  if (key === 'x') return { exit: 'operator', op: 'delete' }
  if (key === 's') return { exit: 'operator', op: 'change' }
  if (key === 'X' || key === 'D') {
    return { exit: 'operator', op: 'delete', forceLinewise: true }
  }
  if (key === 'C' || key === 'S' || key === 'R') {
    return { exit: 'operator', op: 'change', forceLinewise: true }
  }
  if (key === 'Y') return { exit: 'operator', op: 'yank', forceLinewise: true }
  if (key === 'r') return { next: { type: 'replace' } }
  if (key === '~') return { exit: 'case', op: 'toggle' }
  if (key === 'u') return { exit: 'case', op: 'lower' }
  if (key === 'U') return { exit: 'case', op: 'upper' }
  if (key === 'p' || key === 'P') return { exit: 'paste' }
  if (key === '>' || key === '<') return { exit: 'indent', dir: key, count }
  if (key === 'v' || key === 'V') return { exit: 'toggleKind', key }
  if (key === 'o') return { exit: 'swap' }
  if (key === 'J') return { exit: 'join' }
  if (isTextObjScopeKey(key)) {
    return {
      next: { type: 'textObject', scope: TEXT_OBJ_SCOPES[key], count },
    }
  }
  if (SIMPLE_MOTIONS.has(key)) {
    return {
      next: { type: 'idle' },
      move: () => ctx.setOffset(visualMotion(key, ctx.cursor, count)),
    }
  }
  if (FIND_KEYS.has(key)) {
    return { next: { type: 'find', find: key as FindType, count } }
  }
  if (key === 'g') return { next: { type: 'g', count } }
  if (key === 'G') {
    return {
      next: { type: 'idle' },
      move: () => {
        const target =
          count === 1 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count)
        ctx.setOffset(target.offset)
      },
    }
  }
  if (key === ';' || key === ',') {
    return {
      next: { type: 'idle' },
      move: () => {
        const last = ctx.getLastFind()
        if (!last) return
        let type = last.type
        if (key === ',') {
          type = ({ f: 'F', F: 'f', t: 'T', T: 't' } as const)[type]
        }
        const offset = ctx.cursor.findCharacter(last.char, type, count)
        if (offset !== null) ctx.setOffset(offset)
      },
    }
  }
  return null
}

/** Official 2.1.118 H44 */
export function visualTransition(
  state: VisualCommandState,
  input: string,
  ctx: VisualTransitionContext,
): VisualTransitionResult {
  switch (state.type) {
    case 'idle': {
      if (/[1-9]/.test(input)) return { next: { type: 'count', digits: input } }
      if (input === '0') {
        return {
          next: { type: 'idle' },
          move: () => ctx.setOffset(ctx.cursor.startOfLogicalLine().offset),
        }
      }
      return visualCommand(input, 1, ctx) ?? { next: { type: 'idle' } }
    }
    case 'count': {
      if (/[0-9]/.test(input)) {
        const digits = state.digits + input
        const n = Math.min(parseInt(digits, 10), MAX_VIM_COUNT)
        return { next: { type: 'count', digits: String(n) } }
      }
      const count = parseInt(state.digits, 10)
      return visualCommand(input, count, ctx) ?? { next: { type: 'idle' } }
    }
    case 'find':
      return {
        next: { type: 'idle' },
        move: () => {
          const offset = ctx.cursor.findCharacter(
            input,
            state.find,
            state.count,
          )
          if (offset !== null) {
            ctx.setOffset(offset)
            ctx.setLastFind(state.find, input)
          }
        },
      }
    case 'g': {
      if (input === 'j' || input === 'k') {
        return {
          next: { type: 'idle' },
          move: () =>
            ctx.setOffset(visualMotion(`g${input}`, ctx.cursor, state.count)),
        }
      }
      if (input === 'g') {
        return {
          next: { type: 'idle' },
          move: () => {
            const target =
              state.count > 1
                ? ctx.cursor.goToLine(state.count)
                : ctx.cursor.startOfFirstLine()
            ctx.setOffset(target.offset)
          },
        }
      }
      return { next: { type: 'idle' } }
    }
    case 'replace':
      if (input === '') return { next: { type: 'idle' } }
      return { exit: 'replace', char: input }
    case 'textObject': {
      if (TEXT_OBJ_TYPES.has(input)) {
        const range = findTextObject(
          ctx.text,
          ctx.cursor.offset,
          input,
          state.scope === 'inner',
        )
        if (range) {
          return { exit: 'selectRange', start: range.start, end: range.end }
        }
      }
      return { next: { type: 'idle' } }
    }
  }
}
