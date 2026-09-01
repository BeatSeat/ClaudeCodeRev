/**
 * MDM (Mobile Device Management) profile enforcement for Claude Code managed settings.
 *
 * Reads enterprise settings from OS-level MDM configuration:
 * - macOS: `com.anthropic.claudecode` preference domain
 *   (MDM profiles at /Library/Managed Preferences/ only — not user-writable ~/Library/Preferences/)
 * - Windows: `HKLM\SOFTWARE\Policies\ClaudeCode` (admin-only)
 *   and `HKCU\SOFTWARE\Policies\ClaudeCode` (user-writable, lowest priority)
 * - Linux: No MDM equivalent (uses /etc/claude-code/managed-settings.json instead)
 *
 * Policy settings use "first source wins" — the highest-priority source that exists
 * provides all policy settings. Priority (highest to lowest):
 *   remote → HKLM/plist → managed-settings.json → HKCU
 *
 * Architecture:
 *   constants.ts — shared constants and plist path builder (zero heavy imports)
 *   rawRead.ts   — subprocess I/O only (zero heavy imports, fires at main.tsx evaluation)
 *   settings.ts  — parsing, caching, first-source-wins logic (this file)
 */

import { join } from 'path'
import { logForDebugging } from '../../debug.js'
import { logForDiagnosticsNoPII } from '../../diagLogs.js'
import { readFileSync } from '../../fileRead.js'
import { getFsImplementation } from '../../fsOperations.js'
import { safeParseJSON } from '../../json.js'
import { profileCheckpoint } from '../../startupProfiler.js'
import { getManagedFilePath } from '../managedPath.js'
import { type SettingsJson, SettingsSchema } from '../types.js'
import {
  filterSettingsWarnings,
  formatZodError,
  type ValidationError,
} from '../validation.js'
import {
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
  WSL_WINDOWS_MANAGED_DIR,
} from './constants.js'
import {
  fireRawRead,
  getMdmRawReadPromise,
  isWsl,
  type RawReadResult,
} from './rawRead.js'

// ---------------------------------------------------------------------------
// Types and cache
// ---------------------------------------------------------------------------

type MdmResult = { settings: SettingsJson; errors: ValidationError[] }
const EMPTY_RESULT: MdmResult = Object.freeze({ settings: {}, errors: [] })
let mdmCache: MdmResult | null = null
let hkcuCache: MdmResult | null = null
/** 118 `KW$` — WSL opted into the Windows policy chain. */
let wslInheritsCache = false
let mdmLoadPromise: Promise<void> | null = null

// ---------------------------------------------------------------------------
// Startup load — fires early, awaited before first settings read
// ---------------------------------------------------------------------------

/**
 * Kick off async MDM/HKCU reads. Call this as early as possible in
 * startup so the subprocess runs in parallel with module loading.
 */
export function startMdmSettingsLoad(): void {
  if (mdmLoadPromise) return
  mdmLoadPromise = (async () => {
    profileCheckpoint('mdm_load_start')
    const startTime = Date.now()

    // Use the startup raw read if cli.tsx fired it, otherwise fire a fresh one.
    // Both paths produce the same RawReadResult; consumeRawReadResult parses it.
    const rawPromise = getMdmRawReadPromise() ?? fireRawRead()
    const { mdm, hkcu, wslInherits } = consumeRawReadResult(await rawPromise)
    mdmCache = mdm
    hkcuCache = hkcu
    wslInheritsCache = wslInherits
    profileCheckpoint('mdm_load_end')

    const duration = Date.now() - startTime
    logForDebugging(`MDM settings load completed in ${duration}ms`)
    if (Object.keys(mdm.settings).length > 0) {
      logForDebugging(
        `MDM settings found: ${Object.keys(mdm.settings).join(', ')}`,
      )
      try {
        logForDiagnosticsNoPII('info', 'mdm_settings_loaded', {
          duration_ms: duration,
          key_count: Object.keys(mdm.settings).length,
          error_count: mdm.errors.length,
        })
      } catch {
        // Diagnostic logging is best-effort
      }
    }
  })()
}

/**
 * Await the in-flight MDM load. Call this before the first settings read.
 * If startMdmSettingsLoad() was called early enough, this resolves immediately.
 */
export async function ensureMdmSettingsLoaded(): Promise<void> {
  if (!mdmLoadPromise) {
    startMdmSettingsLoad()
  }
  await mdmLoadPromise
}

// ---------------------------------------------------------------------------
// Sync cache readers — used by the settings pipeline (loadSettingsFromDisk)
// ---------------------------------------------------------------------------

/**
 * Read admin-controlled MDM settings from the session cache.
 *
 * Returns settings from admin-only sources:
 * - macOS: /Library/Managed Preferences/ (requires root)
 * - Windows: HKLM registry (requires admin)
 *
 * Does NOT include HKCU (user-writable) — use getHkcuSettings() for that.
 */
export function getMdmSettings(): MdmResult {
  return mdmCache ?? EMPTY_RESULT
}

/**
 * Read HKCU registry settings (user-writable, lowest policy priority).
 * Only relevant on Windows — returns empty on other platforms.
 */
export function getHkcuSettings(): MdmResult {
  return hkcuCache ?? EMPTY_RESULT
}

/** 118 `Na` — WSL inherit flag after consume. */
export function getWslInherits(): boolean {
  return wslInheritsCache
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/**
 * Clear the MDM and HKCU settings caches, forcing a fresh read on next load.
 */
export function clearMdmSettingsCache(): void {
  mdmCache = null
  hkcuCache = null
  wslInheritsCache = false
  mdmLoadPromise = null
}

/**
 * Update the session caches directly. Used by the change detector poll.
 * 118 `ol6(mdm, hkcu, wslInherits)`.
 */
export function setMdmSettingsCache(
  mdm: MdmResult,
  hkcu: MdmResult,
  wslInherits = false,
): void {
  mdmCache = mdm
  hkcuCache = hkcu
  wslInheritsCache = wslInherits
}

// ---------------------------------------------------------------------------
// Refresh — fires a fresh raw read, parses, returns results.
// Used by the 30-minute poll in changeDetector.ts.
// ---------------------------------------------------------------------------

/**
 * Fire a fresh MDM subprocess read and parse the results.
 * Does NOT update the cache — caller decides whether to apply.
 */
export async function refreshMdmSettings(): Promise<{
  mdm: MdmResult
  hkcu: MdmResult
  wslInherits: boolean
}> {
  const raw = await fireRawRead()
  return consumeRawReadResult(raw)
}

// ---------------------------------------------------------------------------
// Parsing — converts raw subprocess output to validated MdmResult
// ---------------------------------------------------------------------------

/**
 * Parse JSON command output (plutil stdout or registry JSON value) into SettingsJson.
 * Filters invalid permission rules before schema validation so one bad rule
 * doesn't cause the entire MDM settings to be rejected.
 */
export function parseCommandOutputAsSettings(
  stdout: string,
  sourcePath: string,
): { settings: SettingsJson; errors: ValidationError[] } {
  const data = safeParseJSON(stdout, false)
  if (!data || typeof data !== 'object') {
    return { settings: {}, errors: [] }
  }

  const ruleWarnings = filterSettingsWarnings(data, sourcePath)
  const parseResult = SettingsSchema().safeParse(data)
  if (!parseResult.success) {
    const errors = formatZodError(parseResult.error, sourcePath)
    return { settings: {}, errors: [...ruleWarnings, ...errors] }
  }
  return { settings: parseResult.data, errors: ruleWarnings }
}

/**
 * Parse reg query stdout to extract a registry string value.
 * Matches both REG_SZ and REG_EXPAND_SZ, case-insensitive.
 *
 * Expected format:
 *     Settings    REG_SZ    {"json":"value"}
 */
export function parseRegQueryStdout(
  stdout: string,
  valueName = 'Settings',
): string | null {
  const lines = stdout.split(/\r?\n/)
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s+${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'i')
  for (const line of lines) {
    const match = line.match(re)
    if (match && match[1]) {
      return match[1].trimEnd()
    }
  }
  return null
}

/**
 * Convert raw subprocess output into parsed MDM and HKCU results,
 * applying the first-source-wins policy.
 */
function stripWslInheritFlag(settings: SettingsJson): SettingsJson {
  const { wslInheritsWindowsSettings: _flag, ...rest } = settings
  return rest
}

/**
 * 118 `sl6` — first-source-wins plus WSL inherit gate.
 */
function consumeRawReadResult(raw: RawReadResult): {
  mdm: MdmResult
  hkcu: MdmResult
  wslInherits: boolean
} {
  const collectedErrors: ValidationError[] = []

  // macOS: plist result (first source wins — already filtered in mdmRawRead)
  if (raw.plistStdouts && raw.plistStdouts.length > 0) {
    const { stdout, label } = raw.plistStdouts[0]!
    const result = parseCommandOutputAsSettings(stdout, label)
    const remainder = stripWslInheritFlag(result.settings)
    if (Object.keys(remainder).length > 0) {
      return { mdm: result, hkcu: EMPTY_RESULT, wslInherits: false }
    }
    collectedErrors.push(...result.errors)
  }

  let hklm: MdmResult | null = null
  if (raw.hklmStdout) {
    const jsonString = parseRegQueryStdout(raw.hklmStdout)
    if (jsonString) {
      hklm = parseCommandOutputAsSettings(
        jsonString,
        `Registry: ${WINDOWS_REGISTRY_KEY_PATH_HKLM}\\${WINDOWS_REGISTRY_VALUE_NAME}`,
      )
    }
  }
  if (hklm) {
    collectedErrors.push(...hklm.errors)
  }
  const errorsOnly: MdmResult =
    collectedErrors.length > 0
      ? { settings: {}, errors: collectedErrors }
      : EMPTY_RESULT

  const wsl = isWsl()
  let wslInherits = false
  if (wsl) {
    wslInherits =
      hklm?.settings.wslInheritsWindowsSettings === true ||
      windowsManagedSettingsHasInheritFlag()
    if (!wslInherits) {
      return { mdm: errorsOnly, hkcu: EMPTY_RESULT, wslInherits: false }
    }
  }

  if (hklm) {
    const remainder = stripWslInheritFlag(hklm.settings)
    if (Object.keys(remainder).length > 0) {
      return { mdm: hklm, hkcu: EMPTY_RESULT, wslInherits }
    }
  }

  // 118 `pr4`: skip HKCU when a higher-priority file source exists
  if (hasManagedSettingsFile(wslInherits)) {
    return { mdm: errorsOnly, hkcu: EMPTY_RESULT, wslInherits }
  }

  if (raw.hkcuStdout) {
    const jsonString = parseRegQueryStdout(raw.hkcuStdout)
    if (jsonString) {
      const result = parseCommandOutputAsSettings(
        jsonString,
        `Registry: ${WINDOWS_REGISTRY_KEY_PATH_HKCU}\\${WINDOWS_REGISTRY_VALUE_NAME}`,
      )
      if (!wsl || result.settings.wslInheritsWindowsSettings === true) {
        return {
          mdm: errorsOnly,
          hkcu: {
            settings: stripWslInheritFlag(result.settings),
            errors: result.errors,
          },
          wslInherits,
        }
      }
      if (result.errors.length > 0) {
        return {
          mdm: errorsOnly,
          hkcu: { settings: {}, errors: result.errors },
          wslInherits,
        }
      }
    }
  }

  return { mdm: errorsOnly, hkcu: EMPTY_RESULT, wslInherits }
}

/** 118 `nl6` — file has keys besides the inherit flag. */
function managedFileHasPolicyContent(filePath: string): boolean {
  const data = safeParseJSON(readFileSync(filePath), false)
  if (!data || typeof data !== 'object') {
    return false
  }
  filterSettingsWarnings(data, filePath)
  const { wslInheritsWindowsSettings: _flag, ...rest } = data as SettingsJson
  return Object.keys(rest).length > 0
}

/** 118 `il6` — managed-settings.json or any drop-in has policy content. */
function hasManagedContentInDir(dir: string): boolean {
  try {
    if (managedFileHasPolicyContent(join(dir, 'managed-settings.json'))) {
      return true
    }
  } catch {
    // missing base file
  }
  try {
    const dropInDir = join(dir, 'managed-settings.d')
    const entries = getFsImplementation().readdirSync(dropInDir)
    for (const d of entries) {
      if (
        !(d.isFile() || d.isSymbolicLink()) ||
        !d.name.endsWith('.json') ||
        d.name.startsWith('.')
      ) {
        continue
      }
      try {
        if (managedFileHasPolicyContent(join(dropInDir, d.name))) {
          return true
        }
      } catch {
        // skip unreadable/malformed file
      }
    }
  } catch {
    // drop-in dir doesn't exist
  }
  return false
}

/**
 * 118 `pr4` — skip HKCU when a higher-priority file-based source exists.
 * If WSL inherit is on, the Windows managed dir wins over Linux.
 */
function hasManagedSettingsFile(wslInherits: boolean): boolean {
  if (wslInherits && hasManagedContentInDir(WSL_WINDOWS_MANAGED_DIR)) {
    return true
  }
  return hasManagedContentInDir(getManagedFilePath())
}

/** 118 `Br4` — Windows managed file/drop-in sets the inherit flag. */
function windowsManagedSettingsHasInheritFlag(): boolean {
  function fileHasFlag(filePath: string): boolean {
    try {
      const data = safeParseJSON(readFileSync(filePath), false)
      return (
        !!data &&
        typeof data === 'object' &&
        'wslInheritsWindowsSettings' in data &&
        (data as SettingsJson).wslInheritsWindowsSettings === true
      )
    } catch {
      return false
    }
  }
  if (fileHasFlag(join(WSL_WINDOWS_MANAGED_DIR, 'managed-settings.json'))) {
    return true
  }
  try {
    const dropInDir = join(WSL_WINDOWS_MANAGED_DIR, 'managed-settings.d')
    for (const d of getFsImplementation().readdirSync(dropInDir)) {
      if (
        (d.isFile() || d.isSymbolicLink()) &&
        d.name.endsWith('.json') &&
        !d.name.startsWith('.') &&
        fileHasFlag(join(dropInDir, d.name))
      ) {
        return true
      }
    }
  } catch {
    // no drop-ins
  }
  return false
}

/**
 * 118 `O28` — WSL Windows managed-file fingerprint for MDM poll.
 * Joins file contents with `\x01`; drop-in name/content with `\x00`.
 */
export function getWslWindowsFileFingerprint(): string {
  if (!isWsl() || !wslInheritsCache) {
    return ''
  }
  const parts: string[] = []
  try {
    parts.push(readFileSync(join(WSL_WINDOWS_MANAGED_DIR, 'managed-settings.json')))
  } catch {
    parts.push('')
  }
  try {
    const dropInDir = join(WSL_WINDOWS_MANAGED_DIR, 'managed-settings.d')
    const names = getFsImplementation()
      .readdirSync(dropInDir)
      .filter(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
      .map(d => d.name)
      .sort()
    for (const name of names) {
      try {
        parts.push(`${name}\0${readFileSync(join(dropInDir, name))}`)
      } catch {
        parts.push(`${name}\0`)
      }
    }
  } catch {
    // no drop-ins
  }
  return parts.join('\x01')
}
