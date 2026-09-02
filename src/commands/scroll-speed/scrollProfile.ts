import { isXtermJs } from '../../ink/terminal.js'

export const SCROLL_SPEED_ENV = 'CLAUDE_CODE_SCROLL_SPEED'
const SLIDER_MIN = 1
const SLIDER_MAX = 10
const ENV_CAP = 20

export type ScrollProfile = {
  useDecayCurve: boolean
  useAdaptiveDrain: boolean
  base: number
  xtermJs: boolean
  wheelFlood: boolean
  jediTerm: boolean
  termProgram: string
  termProgramVersion: string
  wtSession: boolean
  platform: NodeJS.Platform
}

let cached: ScrollProfile | undefined

/** Official 139 x_$.isJetBrainsIdeTerminal — JediTerm env only. */
export function isJetBrainsIdeTerminal(): boolean {
  return process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
}

/** Official 139 bq6 — auto lines/notch when env is unset. */
export function autoScrollSpeed(
  xtermJs: boolean,
  wheelFlood: boolean,
  wtSession: boolean,
): number {
  // Bundle inlined process.platform==="win32" as false on the linux artifact.
  return !wheelFlood &&
    (xtermJs || process.platform === 'win32' || wtSession)
    ? 3
    : 1
}

/** Official 139 CI1 — env override, else auto. Clamp (0, 20]. */
export function appliedScrollSpeed(
  xtermJs: boolean,
  wheelFlood: boolean,
  wtSession: boolean,
): number {
  const fallback = autoScrollSpeed(xtermJs, wheelFlood, wtSession)
  const raw = process.env[SCROLL_SPEED_ENV]
  if (!raw) return fallback
  const n = parseFloat(raw)
  return Number.isNaN(n) || n <= 0 ? fallback : Math.min(n, ENV_CAP)
}

/** Official 139 Cq6 — high-rate wheel hosts (Cursor / a vscode version band). */
export function isWheelFlood(): boolean {
  if (process.env.CURSOR_TRACE_ID !== undefined) return true
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('cursor')) return true
  if (process.env.TERM_PROGRAM === 'vscode') {
    const version = parseTermProgramVersion(process.env.TERM_PROGRAM_VERSION)
    if (version !== null) return version >= 1_092_000 && version < 1_105_000
    return false
  }
  // Official last check is XTVERSION startsWith "xterm.js". isXtermJs() on
  // a non-vscode TERM_PROGRAM is that probe; vscode already returned above.
  return isXtermJs()
}

function parseTermProgramVersion(raw: string | undefined): number | null {
  if (!raw) return null
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!m) return null
  return Number(m[1]) * 1e6 + Number(m[2]) * 1000 + Number(m[3])
}

/** Official 139 Dv — cached scroll-environment snapshot. */
export function getScrollProfile(): ScrollProfile {
  const xtermJs = isXtermJs()
  const wheelFlood = isWheelFlood()
  const jediTerm = isJetBrainsIdeTerminal()
  const wtSession = !!process.env.WT_SESSION
  if (
    cached &&
    cached.wheelFlood === wheelFlood &&
    cached.jediTerm === jediTerm &&
    cached.wtSession === wtSession &&
    cached.xtermJs === xtermJs
  ) {
    return cached
  }
  cached = {
    useDecayCurve:
      !wheelFlood && (xtermJs || process.platform === 'win32' || wtSession),
    useAdaptiveDrain: xtermJs,
    base: jediTerm ? 2 : appliedScrollSpeed(xtermJs, wheelFlood, wtSession),
    xtermJs,
    wheelFlood,
    jediTerm,
    termProgram: process.env.TERM_PROGRAM ?? 'unset',
    termProgramVersion: process.env.TERM_PROGRAM_VERSION ?? 'unset',
    wtSession,
    platform: process.platform,
  }
  return cached
}

/** Official 139 Xi$ — drop the Dv() cache so the next read sees env changes. */
export function invalidateScrollProfile(): void {
  cached = undefined
}

export function clampSlider(n: number): number {
  return Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, n))
}

export function speedBar(value: number): string {
  const n = clampSlider(value)
  return '■'.repeat(n) + '·'.repeat(SLIDER_MAX - n)
}

/** Official 139 NL5 */
export function terminalProductName(profile: ScrollProfile): string {
  if (process.env.CURSOR_TRACE_ID !== undefined) return 'Cursor'
  const askpass = process.env.VSCODE_GIT_ASKPASS_MAIN ?? ''
  if (askpass.includes('cursor')) return 'Cursor (remote)'
  if (askpass.includes('windsurf')) return 'Windsurf'
  if (askpass.includes('antigravity')) return 'Antigravity'
  if (profile.termProgram === 'vscode') {
    return `VS Code${profile.termProgramVersion !== 'unset' ? ` ${profile.termProgramVersion}` : ''}`
  }
  switch (profile.termProgram) {
    case 'unset':
      return profile.wtSession || profile.platform === 'win32'
        ? 'Windows console'
        : 'terminal'
    case 'iTerm.app':
      return 'iTerm2'
    case 'Apple_Terminal':
      return 'Terminal.app'
    case 'ghostty':
      return 'Ghostty'
    case 'WezTerm':
      return 'WezTerm'
    case 'WarpTerminal':
      return 'Warp'
    default:
      return profile.termProgram
  }
}

/** Official 139 EL5 */
export function platformLabel(platform: NodeJS.Platform | string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return platform
  }
}

/** Official 139 kL5 */
export function terminalSummary(profile: ScrollProfile): string {
  const parts = [
    terminalProductName(profile),
    platformLabel(profile.platform),
  ]
  if (profile.wheelFlood) parts.push('high-rate wheel events')
  else if (profile.xtermJs) parts.push('xterm.js')
  else if (profile.wtSession) parts.push('Windows Terminal')
  return parts.join(' · ')
}
