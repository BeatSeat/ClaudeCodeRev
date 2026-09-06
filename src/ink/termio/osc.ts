/**
 * OSC (Operating System Command) Types and Parser
 */

import { Buffer } from 'buffer'
import { logForDebugging } from '../../utils/debug.js'
import { env } from '../../utils/env.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getPlatform } from '../../utils/platform.js'
import { BEL, ESC, ESC_TYPE, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './types.js'

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC)

/** String Terminator (ESC \) - alternative to BEL for terminating OSC */
export const ST = ESC + '\\'

/** Generate an OSC sequence: ESC ] p1;p2;...;pN <terminator>
 * Uses ST terminator for Kitty (avoids beeps), BEL for others */
export function osc(...parts: (string | number)[]): string {
  const terminator = env.terminal === 'kitty' ? ST : BEL
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator}`
}

/**
 * Official 176 `my6` — mux from env (this tree has no `Nj()` terminal probe).
 * tmux 3.3+ gates DCS behind `allow-passthrough` (default off).
 */
function detectMux(): 'tmux' | 'screen' | null {
  if (process.env['TMUX']) return 'tmux'
  if (process.env['STY']) return 'screen'
  return null
}

/**
 * Official 176 `lZ`. tmux and GNU screen intercept escape sequences; DCS
 * passthrough tunnels them to the outer terminal. Inner ESCs are doubled
 * for both muxes.
 */
export function wrapForMultiplexer(sequence: string): string {
  const mux = detectMux()
  if (mux === 'tmux') {
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b')
    return `\x1bPtmux;${escaped}\x1b\\`
  }
  if (mux === 'screen') {
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b')
    return `\x1bP${escaped}\x1b\\`
  }
  return sequence
}

/**
 * Which path setClipboard() will take, based on env state. Synchronous so
 * callers can show an honest toast without awaiting the copy itself.
 *
 * - 'native': pbcopy (or equivalent) will run — high-confidence system
 *   clipboard write. tmux buffer may also be loaded as a bonus.
 * - 'tmux-buffer': tmux load-buffer will run, but no native tool — paste
 *   with prefix+] works. System clipboard depends on tmux's set-clipboard
 *   option + outer terminal OSC 52 support; can't know from here.
 * - 'osc52': only the raw OSC 52 sequence will be written to stdout.
 *   Best-effort; iTerm2 disables OSC 52 by default.
 *
 * Native-path gating uses SSH_CONNECTION specifically, not SSH_TTY — tmux
 * panes inherit SSH_TTY forever even after local reattach, but
 * SSH_CONNECTION is in tmux's default update-environment set and gets
 * cleared. Official 2.1.160 `gD6` is mux `.ssh` OR this env; this tree
 * has no mux helper, so the env is the gate.
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

const VSCODE_FAMILY = new Set([
  'vscode',
  'cursor',
  'windsurf',
  'antigravity',
  'codium',
])

const SHIFT_SELECT_TERMINALS = new Set([
  'ghostty',
  'kitty',
  'WezTerm',
  'alacritty',
  'xterm',
  'gnome-terminal',
  'vte-based',
  'konsole',
  'windows-terminal',
  'mintty',
])

function isClipboardSshSession(): boolean {
  return Boolean(process.env['SSH_CONNECTION'])
}

/**
 * Official `D78` — modifier the toast tells the user to hold for native copy
 * when OSC 52 may not have landed in the system clipboard.
 */
export function nativeCopyModifierHint(): string {
  const terminal = env.terminal
  if (terminal === 'Apple_Terminal') return 'Fn'
  if (terminal === 'iTerm.app') return 'Option'
  if (
    process.env.TERM_PROGRAM === 'vscode' ||
    (terminal !== null && VSCODE_FAMILY.has(terminal))
  ) {
    return getPlatform() === 'macos' ? 'Option' : 'Shift'
  }
  if (terminal !== null && SHIFT_SELECT_TERMINALS.has(terminal)) return 'Shift'
  if (process.env.LC_TERMINAL === 'iTerm2') return 'Option'
  const mux = Boolean(process.env.TMUX || process.env.STY)
  if (isClipboardSshSession() || mux || getPlatform() === 'macos') {
    return 'Shift (Option in iTerm2, Fn in Terminal.app)'
  }
  return 'Shift'
}

export function getClipboardPath(): ClipboardPath {
  const platform = getPlatform()
  if (
    (platform === 'macos' || platform === 'windows' || platform === 'wsl') &&
    !isClipboardSshSession()
  ) {
    return 'native'
  }
  if (process.env['TMUX']) return 'tmux-buffer'
  return 'osc52'
}

/**
 * Official 176 `Dc_`. Always try `load-buffer -w` first (tmux 3.2+). If that
 * fails (unknown option on tmux <3.2, or iTerm2/SSH), retry without `-w`.
 * 175 special-cased iTerm2 to skip `-w` and never retried — older tmux then
 * failed to load the paste buffer at all.
 */
export async function tmuxLoadBuffer(text: string): Promise<boolean> {
  if (!process.env['TMUX']) return false
  const opts = { input: text, useCwd: false, timeout: 2000 }
  const lc = process.env['LC_TERMINAL'] ?? 'unset'
  const { code } = await execFileNoThrow(
    'tmux',
    ['load-buffer', '-w', '-'],
    opts,
  )
  logForDebugging(
    `clipboard: tmux load-buffer -w - \u2192 exit ${code} (LC_TERMINAL=${lc})`,
  )
  if (code === 0) return true
  const retry = await execFileNoThrow('tmux', ['load-buffer', '-'], opts)
  logForDebugging(
    `clipboard: retry tmux load-buffer - \u2192 exit ${retry.code} (LC_TERMINAL=${lc})`,
  )
  return retry.code === 0
}

/**
 * Official 176 `y0`. Native copy (not SSH) + tmux load-buffer, then emit OSC 52
 * by mux: tmux always gets raw+DCS (so SSH/tmux still reaches the outer
 * clipboard even when `-w` failed), screen gets DCS only, else raw OSC 52.
 * Load-buffer success does not gate the emit path.
 */
export async function setClipboard(text: string): Promise<string> {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const ssh = isClipboardSshSession()
  if (!ssh) copyNative(text)
  await tmuxLoadBuffer(text)

  const mux = detectMux()
  const rawOsc52 = `${ESC}]52;c;${b64}${BEL}`
  const emit = mux === 'tmux' ? 'raw+dcs' : mux === 'screen' ? 'dcs' : 'raw'
  logForDebugging(
    `clipboard: setClipboard mux=${mux ?? 'none'} ssh=${ssh} native=${!ssh} predicted=${getClipboardPath()} emit=${emit} bytes=${text.length}`,
  )
  if (mux === 'tmux') return rawOsc52 + wrapForMultiplexer(rawOsc52)
  if (mux === 'screen') return wrapForMultiplexer(rawOsc52)
  return osc(OSC.CLIPBOARD, 'c', b64)
}

// Linux clipboard tool: undefined = not yet probed, null = none available.
// Probe order: wl-copy (Wayland) → xclip (X11) → xsel (X11 fallback).
// Cached after first attempt so repeated mouse-ups skip the probe chain.
let linuxCopy: 'wl-copy' | 'xclip' | 'xsel' | null | undefined

/**
 * Shell out to a native clipboard utility as a safety net for OSC 52.
 * Only called when not in an SSH session (over SSH, these would write to
 * the remote machine's clipboard — OSC 52 is the right path there).
 * Fire-and-forget: failures are silent since OSC 52 may have succeeded.
 */
function copyNative(text: string): void {
  const opts = { input: text, useCwd: false, timeout: 2000 }
  const powershellClipboard =
    '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'
  switch (getPlatform()) {
    case 'macos':
      void execFileNoThrow('pbcopy', [], opts)
      return
    case 'linux': {
      if (linuxCopy === null) return
      if (linuxCopy === 'wl-copy') {
        void execFileNoThrow('wl-copy', [], opts)
        void execFileNoThrow('wl-copy', ['--primary'], opts)
        return
      }
      if (linuxCopy === 'xclip') {
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts)
        void execFileNoThrow('xclip', ['-selection', 'primary'], opts)
        return
      }
      if (linuxCopy === 'xsel') {
        void execFileNoThrow('xsel', ['--clipboard', '--input'], opts)
        void execFileNoThrow('xsel', ['--primary', '--input'], opts)
        return
      }
      // First call: probe wl-copy (Wayland) then xclip/xsel (X11), cache winner.
      void execFileNoThrow('wl-copy', [], opts).then(r => {
        if (r.code === 0) {
          linuxCopy = 'wl-copy'
          void execFileNoThrow('wl-copy', ['--primary'], opts)
          return
        }
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts).then(
          r2 => {
            if (r2.code === 0) {
              linuxCopy = 'xclip'
              void execFileNoThrow('xclip', ['-selection', 'primary'], opts)
              return
            }
            void execFileNoThrow('xsel', ['--clipboard', '--input'], opts).then(
              r3 => {
                linuxCopy = r3.code === 0 ? 'xsel' : null
                if (r3.code === 0) {
                  void execFileNoThrow('xsel', ['--primary', '--input'], opts)
                }
              },
            )
          },
        )
      })
      return
    }
    case 'wsl': {
      void execFileNoThrow(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', powershellClipboard],
        opts,
      )
      return
    }
    case 'windows': {
      void execFileNoThrow(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', powershellClipboard],
        opts,
      )
      return
    }
  }
}

/** @internal test-only */
export function _resetLinuxCopyCache(): void {
  linuxCopy = undefined
}

/**
 * OSC command numbers
 */
export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9, // iTerm2 proprietary sequences
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  CLIPBOARD: 52,
  KITTY: 99, // Kitty notification protocol
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777, // Ghostty notification protocol
  TAB_STATUS: 21337, // Tab status extension
} as const

/**
 * Parse an OSC sequence into an action
 *
 * @param content - The sequence content (without ESC ] and terminator)
 */
export function parseOSC(content: string): Action | null {
  const semicolonIdx = content.indexOf(';')
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : ''

  const commandNum = parseInt(command, 10)

  // Window/icon title
  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: 'title', action: { type: 'both', title: data } }
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: 'title', action: { type: 'iconName', name: data } }
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: 'title', action: { type: 'windowTitle', title: data } }
  }

  // Hyperlinks (OSC 8)
  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(';')
    const paramsStr = parts[0] ?? ''
    const url = parts.slice(1).join(';')

    if (url === '') {
      return { type: 'link', action: { type: 'end' } }
    }

    const params: Record<string, string> = {}
    if (paramsStr) {
      for (const pair of paramsStr.split(':')) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }

    return {
      type: 'link',
      action: {
        type: 'start',
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    }
  }

  // Tab status (OSC 21337)
  if (commandNum === OSC.TAB_STATUS) {
    return { type: 'tabStatus', action: parseTabStatus(data) }
  }

  return { type: 'unknown', sequence: `\x1b]${content}` }
}

/**
 * Parse an XParseColor-style color spec into an RGB Color.
 * Accepts `#RRGGBB` and `rgb:R/G/B` (1–4 hex digits per component, scaled
 * to 8-bit). Returns null on parse failure.
 */
export function parseOscColor(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex) {
    return {
      type: 'rgb',
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    }
  }
  const rgb = spec.match(
    /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i,
  )
  if (rgb) {
    // XParseColor: N hex digits → value / (16^N - 1), scale to 0-255
    const scale = (s: string) =>
      Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255)
    return {
      type: 'rgb',
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    }
  }
  return null
}

/**
 * Parse OSC 21337 payload: `key=value;key=value;...` with `\;` and `\\`
 * escapes inside values. Bare key or `key=` clears that field; unknown
 * keys are ignored.
 */
function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {}
  for (const [key, value] of splitTabStatusPairs(data)) {
    switch (key) {
      case 'indicator':
        action.indicator = value === '' ? null : parseOscColor(value)
        break
      case 'status':
        action.status = value === '' ? null : value
        break
      case 'status-color':
        action.statusColor = value === '' ? null : parseOscColor(value)
        break
    }
  }
  return action
}

/** Split `k=v;k=v` honoring `\;` and `\\` escapes. Yields [key, unescapedValue]. */
function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = ''
  let val = ''
  let inVal = false
  let esc = false
  for (const c of data) {
    if (esc) {
      if (inVal) val += c
      else key += c
      esc = false
    } else if (c === '\\') {
      esc = true
    } else if (c === ';') {
      yield [key, val]
      key = ''
      val = ''
      inVal = false
    } else if (c === '=' && !inVal) {
      inVal = true
    } else if (inVal) {
      val += c
    } else {
      key += c
    }
  }
  if (key || inVal) yield [key, val]
}

// Output generators

/** Start a hyperlink (OSC 8). Auto-assigns an id= param derived from the URL
 *  so terminals group wrapped lines of the same link together (the spec says
 *  cells with matching URI *and* nonempty id are joined; without an id each
 *  wrapped line is a separate link — inconsistent hover, partial tooltips).
 *  Empty url = close sequence (empty params per spec). */
export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END
  const p = { id: osc8Id(url), ...params }
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(':')
  return osc(OSC.HYPERLINK, paramStr, url)
}

function osc8Id(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++)
    h = ((h << 5) - h + url.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** End a hyperlink (OSC 8) */
export const LINK_END = osc(OSC.HYPERLINK, '', '')

// iTerm2 OSC 9 subcommands

/** iTerm2 OSC 9 subcommand numbers */
export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const

/** Progress operation codes (for use with ITERM2.PROGRESS) */
export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const

/**
 * Clear iTerm2 progress bar sequence (OSC 9;4;0;BEL)
 * Uses BEL terminator since this is for cleanup (not runtime notification)
 * and we want to ensure it's always sent regardless of terminal type.
 */
export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`

/**
 * Clear terminal title sequence (OSC 0 with empty string + BEL).
 * Uses BEL terminator for cleanup — safe on all terminals.
 */
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`

/** Clear all three OSC 21337 tab-status fields. Used on exit. */
export const CLEAR_TAB_STATUS = osc(
  OSC.TAB_STATUS,
  'indicator=;status=;status-color=',
)

/**
 * Gate for emitting OSC 21337 (tab-status indicator). Ant-only while the
 * spec is unstable. Terminals that don't recognize it discard silently, so
 * emission is safe unconditionally — we don't gate on terminal detection
 * since support is expected across several terminals.
 *
 * Callers must wrap output with wrapForMultiplexer() so tmux/screen
 * DCS-passthrough carries the sequence to the outer terminal.
 */
export function supportsTabStatus(): boolean {
  return process.env.USER_TYPE === 'ant'
}

/**
 * Emit an OSC 21337 tab-status sequence. Omitted fields are left unchanged
 * by the receiving terminal; `null` sends an empty value to clear.
 * `;` and `\` in status text are escaped per the spec.
 */
export function tabStatus(fields: TabStatusAction): string {
  const parts: string[] = []
  const rgb = (c: Color) =>
    c.type === 'rgb'
      ? `#${[c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('')}`
      : ''
  if ('indicator' in fields)
    parts.push(`indicator=${fields.indicator ? rgb(fields.indicator) : ''}`)
  if ('status' in fields)
    parts.push(
      `status=${fields.status?.replaceAll('\\', '\\\\').replaceAll(';', '\\;') ?? ''}`,
    )
  if ('statusColor' in fields)
    parts.push(
      `status-color=${fields.statusColor ? rgb(fields.statusColor) : ''}`,
    )
  return osc(OSC.TAB_STATUS, parts.join(';'))
}
