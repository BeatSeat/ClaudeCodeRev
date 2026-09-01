import { parseChord } from './parser.js'
import type { Chord, ParsedKeystroke } from './types.js'

type Keystroke = ParsedKeystroke & { super?: boolean }

export type ShortcutFormatStyle = 'default' | 'compact' | 'symbol'

export type ShortcutFormatOptions = {
  style?: ShortcutFormatStyle
  keyCase?: 'title' | 'lower' | 'glyph'
  modCase?: 'lower' | 'title' | 'glyph'
  caretCtrl?: boolean
  modSep?: string
  arrowSep?: string
  chordSep?: string
  shiftAsCase?: boolean
  charCase?: 'preserve' | 'upper'
  platform?: 'macos' | 'other'
}

type ResolvedFormat = Required<
  Omit<ShortcutFormatOptions, 'style'>
>

const PRESETS: Record<ShortcutFormatStyle, ResolvedFormat> = {
  default: {
    keyCase: 'title',
    modCase: 'lower',
    caretCtrl: false,
    modSep: '+',
    arrowSep: '/',
    chordSep: ' ',
    shiftAsCase: false,
    charCase: 'preserve',
    platform: 'other',
  },
  compact: {
    keyCase: 'lower',
    modCase: 'lower',
    caretCtrl: true,
    modSep: '+',
    arrowSep: '',
    chordSep: ' ',
    shiftAsCase: true,
    charCase: 'preserve',
    platform: 'other',
  },
  symbol: {
    keyCase: 'glyph',
    modCase: 'glyph',
    caretCtrl: false,
    modSep: '',
    arrowSep: '',
    chordSep: ' ',
    shiftAsCase: true,
    charCase: 'upper',
    platform: 'other',
  },
}

const KEY_NAMES: Record<string, [string, string, string]> = {
  enter: ['Enter', 'enter', '⏎'],
  escape: ['Esc', 'esc', '⎋'],
  tab: ['Tab', 'tab', '⇥'],
  ' ': ['Space', 'space', '␣'],
  backspace: ['Backspace', 'backspace', '⌫'],
  delete: ['Delete', 'delete', '⌦'],
  up: ['↑', '↑', '↑'],
  down: ['↓', '↓', '↓'],
  left: ['←', '←', '←'],
  right: ['→', '→', '→'],
  pageup: ['PageUp', 'pgup', '⇞'],
  pagedown: ['PageDown', 'pgdn', '⇟'],
  home: ['Home', 'home', '↖'],
  end: ['End', 'end', '↘'],
}

const KEY_CASE_INDEX = { title: 0, lower: 1, glyph: 2 } as const

const ARROW_KEYS = new Set(['up', 'down', 'left', 'right'])

const NO_MODS = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  super: false,
} as const

function definedEntries(
  opts: ShortcutFormatOptions,
): Partial<ResolvedFormat> {
  const out: Partial<ResolvedFormat> = {}
  for (const [key, value] of Object.entries(opts) as [
    keyof ShortcutFormatOptions,
    ShortcutFormatOptions[keyof ShortcutFormatOptions],
  ][]) {
    if (key !== 'style' && value !== undefined) {
      ;(out as Record<string, unknown>)[key] = value
    }
  }
  return out
}

function resolveFormat(opts: ShortcutFormatOptions = {}): ResolvedFormat {
  return {
    ...PRESETS[opts.style ?? 'default'],
    ...definedEntries(opts),
  }
}

function modifierNames(ks: Keystroke): string[] {
  const names: string[] = []
  if (ks.ctrl) names.push('ctrl')
  if (ks.shift) names.push('shift')
  if (ks.alt || ks.meta) names.push('alt')
  if (ks.super) names.push('super')
  return names
}

function formatModName(name: string, fmt: ResolvedFormat): string {
  switch (name) {
    case 'ctrl':
      return fmt.modCase === 'glyph'
        ? '⌃'
        : fmt.modCase === 'title'
          ? 'Ctrl'
          : 'ctrl'
    case 'shift':
      return fmt.modCase === 'glyph'
        ? '⇧'
        : fmt.modCase === 'title'
          ? 'Shift'
          : 'shift'
    case 'alt':
      if (fmt.modCase === 'glyph') return '⌥'
      if (fmt.platform === 'macos') {
        return fmt.modCase === 'title' ? 'Opt' : 'opt'
      }
      return fmt.modCase === 'title' ? 'Alt' : 'alt'
    case 'super':
      if (fmt.modCase === 'glyph') return '⌘'
      if (fmt.platform === 'macos') {
        return fmt.modCase === 'title' ? 'Cmd' : 'cmd'
      }
      return fmt.modCase === 'title' ? 'Super' : 'super'
    default:
      return name
  }
}

function formatKeyName(key: string, fmt: ResolvedFormat): string {
  const named = KEY_NAMES[key]
  if (named) {
    return named[KEY_CASE_INDEX[fmt.keyCase === 'glyph' ? 'glyph' : fmt.keyCase]]
  }
  return fmt.charCase === 'upper' ? key.toUpperCase() : key
}

function isShiftAsLetter(ks: Keystroke): boolean {
  return (
    !!ks.shift &&
    !ks.ctrl &&
    !ks.alt &&
    !ks.meta &&
    !ks.super &&
    ks.key.length === 1 &&
    ks.key >= 'a' &&
    ks.key <= 'z'
  )
}

function modsForJoin(ks: Keystroke, fmt: ResolvedFormat): string[] {
  if (fmt.shiftAsCase && isShiftAsLetter(ks)) {
    return []
  }
  return modifierNames(ks)
}

function formatKeystroke(ks: Keystroke, fmt: ResolvedFormat): string {
  if (fmt.shiftAsCase && isShiftAsLetter(ks)) {
    return ks.key.toUpperCase()
  }
  const mods = modifierNames(ks)
  const key = formatKeyName(ks.key, fmt)
  if (fmt.caretCtrl && mods.length === 1 && mods[0] === 'ctrl') {
    return `^${key}`
  }
  if (fmt.modCase === 'glyph') {
    return mods.map(m => formatModName(m, fmt)).join('') + key
  }
  return [...mods.map(m => formatModName(m, fmt)), key].join(fmt.modSep)
}

function commonModifierKeystroke(
  keys: Keystroke[],
  fmt: ResolvedFormat,
): Keystroke | undefined {
  const [first, ...rest] = keys
  if (!first || modsForJoin(first, fmt).length === 0) {
    return undefined
  }
  const same = rest.every(other => {
    const a = modsForJoin(first, fmt)
    const b = modsForJoin(other, fmt)
    return a.length === b.length && a.every((name, i) => name === b[i])
  })
  return same ? first : undefined
}

function formatModPrefix(ks: Keystroke, fmt: ResolvedFormat): string {
  const mods = modifierNames(ks)
  if (fmt.caretCtrl && mods.length === 1 && mods[0] === 'ctrl') {
    return '^'
  }
  if (fmt.modCase === 'glyph') {
    return mods.map(m => formatModName(m, fmt)).join('')
  }
  return mods.map(m => formatModName(m, fmt)).join(fmt.modSep) + fmt.modSep
}

function formatChordList(chords: Chord[], fmt: ResolvedFormat): string {
  const formatOne = (chord: Chord) =>
    chord.map(ks => formatKeystroke(ks, fmt)).join(fmt.chordSep)
  if (chords.length === 0) {
    return ''
  }
  if (chords.length === 1) {
    return formatOne(chords[0]!)
  }
  const singles = chords.every(c => c.length === 1)
    ? chords.map(c => c[0]!)
    : undefined
  if (!singles) {
    return chords.map(formatOne).join('/')
  }
  const common = commonModifierKeystroke(singles, fmt)
  const sep =
    singles.every(ks => ARROW_KEYS.has(ks.key)) &&
    (!!common || singles.every(ks => modsForJoin(ks, fmt).length === 0))
      ? fmt.arrowSep
      : '/'
  if (common) {
    const keys = singles.map(ks =>
      formatKeystroke({ ...ks, ...NO_MODS }, fmt),
    )
    return formatModPrefix(common, fmt) + keys.join(sep)
  }
  return singles.map(ks => formatKeystroke(ks, fmt)).join(sep)
}

/**
 * Format a key or chord list for KeyboardShortcutHint (official 2.1.92 n8/HC4).
 */
export function formatShortcutDisplay(
  chord: string | readonly string[],
  format?: ShortcutFormatOptions,
): string {
  const parts = typeof chord === 'string' ? [chord] : [...chord]
  const chords = parts.map(part => parseChord(part === ' ' ? 'space' : part))
  return formatChordList(chords, resolveFormat(format))
}
