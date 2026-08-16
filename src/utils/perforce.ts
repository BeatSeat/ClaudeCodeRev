import { isEnvTruthy } from './envUtils.js'

/** Owner-write bit (S_IWUSR). Official JZ6: mode & 128 === 0. */
const OWNER_WRITE_BIT = 0o200

export const PERFORCE_READONLY_MESSAGE =
  'File is read-only — it has not been opened for edit in Perforce. Run `p4 edit <file>` to check it out, then retry. Do not chmod the file writable; that bypasses Perforce tracking.'

export function isPerforceMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_PERFORCE_MODE)
}

export function isPerforceReadOnly(mode: number | undefined): boolean {
  return isPerforceMode() && mode !== undefined && (mode & OWNER_WRITE_BIT) === 0
}
