/**
 * Official 2.1.181 screen-reader detection and spawn-env support.
 *
 * Checks `--ax-screen-reader` CLI flag, `CLAUDE_AX_SCREEN_READER` env var,
 * and `axScreenReader` setting from user config.
 */
import { getInitialSettings } from './settings/settings.js'

export const TENGU_AX_SCREEN_READER = 'tengu_ax_screen_reader'

type GateFn = (flag: string, defaultValue: boolean) => boolean
let gateOverride: GateFn | null = null

export function setAxScreenReaderGateOverride(
  fn: GateFn | null,
): GateFn | null {
  const prev = gateOverride
  gateOverride = fn
  return prev
}

class AxScreenReaderManager {
  #enabled: boolean | undefined

  isEnabled(): boolean {
    if (this.#enabled !== undefined) return this.#enabled
    let candidate: boolean | undefined
    if (process.argv.includes('--ax-screen-reader')) {
      candidate = true
    } else {
      const envVal = process.env.CLAUDE_AX_SCREEN_READER
      candidate =
        envVal !== undefined
          ? envVal === '1' || envVal === 'true'
          : (getInitialSettings() as any).axScreenReader === true
    }
    if (!candidate) {
      this.#enabled = false
      return false
    }
    this.#enabled = gateOverride?.(TENGU_AX_SCREEN_READER, true) ?? true
    return this.#enabled
  }

  reset(): void {
    this.#enabled = undefined
  }
}

export const axScreenReader = new AxScreenReaderManager()

export function isAxScreenReaderEnabled(): boolean {
  return axScreenReader.isEnabled()
}

export function getAxScreenReaderSpawnEnv(): Record<string, string> {
  if (axScreenReader.isEnabled()) {
    return { CLAUDE_AX_SCREEN_READER: '1' }
  }
  return {}
}
