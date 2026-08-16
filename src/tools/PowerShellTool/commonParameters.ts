/**
 * PowerShell Common Parameters (available on all cmdlets via [CmdletBinding()]).
 * Source: about_CommonParameters (PowerShell docs) + Get-Command output.
 *
 * Shared between pathValidation.ts (merges into per-cmdlet known-param sets)
 * and readOnlyValidation.ts (merges into safeFlags check). Split out to break
 * what would otherwise be an import cycle between those two files.
 *
 * Stored lowercase with leading dash — callers `.toLowerCase()` their input.
 */

export const COMMON_SWITCHES = ['-verbose', '-debug']

export const COMMON_VALUE_PARAMS = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
  '-errorvariable',
  '-warningvariable',
  '-informationvariable',
  '-outvariable',
  '-outbuffer',
  '-pipelinevariable',
  '-ea',
  '-wa',
  '-infa',
  '-proga',
]

const ACTION_PREFERENCE_FULL = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
]
const ACTION_PREFERENCE_ALIASES = ['-ea', '-wa', '-infa', '-proga']
const DASH_PREFIXES = new Set(['-', '\u2013', '\u2014', '\u2015'])

const SAFE_ACTION_PREFERENCE_VALUES = new Set([
  'silentlycontinue',
  '0',
  'stop',
  '1',
  'continue',
  '2',
  'ignore',
  '4',
])

/** True when -ErrorAction/-ea (etc.) is set to Break/Inquire or another unsafe value. */
export function hasUnsafeActionPreference(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (!raw || !DASH_PREFIXES.has(raw[0]!)) {
      continue
    }
    const normalized = raw[0] === '-' ? raw : `-${raw.slice(1)}`
    const colon = normalized.indexOf(':')
    const name = (colon > 0 ? normalized.slice(0, colon) : normalized).toLowerCase()
    if (name.length < 2) continue
    const isActionPref =
      ACTION_PREFERENCE_ALIASES.includes(name) ||
      ACTION_PREFERENCE_FULL.some(full => full.startsWith(name))
    if (!isActionPref) continue
    const value = (
      colon > 0 ? normalized.slice(colon + 1) : (args[i + 1] ?? '')
    )
      .toLowerCase()
      .replace(/^['"]|['"]$/g, '')
      .trim()
    if (value.length > 0 && !SAFE_ACTION_PREFERENCE_VALUES.has(value)) {
      return true
    }
  }
  return false
}

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  ...COMMON_SWITCHES,
  ...COMMON_VALUE_PARAMS,
])
