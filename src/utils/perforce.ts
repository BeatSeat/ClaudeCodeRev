import { isEnvTruthy } from './envUtils.js'

export const PERFORCE_READONLY_MESSAGE =
  'File is read-only — it has not been opened for edit in Perforce. Run `p4 edit <file>` to check it out, then retry. Do not chmod the file writable; that bypasses Perforce tracking.'

export function isPerforceModeEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_PERFORCE_MODE)
}

/** Official JZ6: perforce mode and file mode lacks owner-write bit 128. */
export function isPerforceReadOnly(mode: number): boolean {
  return isPerforceModeEnabled() && (mode & 128) === 0
}
