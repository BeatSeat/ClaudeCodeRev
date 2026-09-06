import { feature } from 'bun:bundle'
import mergeWith from 'lodash-es/mergeWith.js'
import { dirname, join, resolve } from 'path'
import { z } from 'zod/v4'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getParentManagedSettings,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import { logEvent } from '../../services/analytics/index.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getErrnoCode, isENOENT } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { clone, jsonStringify } from '../slowOperations.js'
import { profileCheckpoint } from '../startupProfiler.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internalWrites.js'
import { getManagedFilePath } from './managedPath.js'
import { WSL_WINDOWS_MANAGED_DIR } from './mdm/constants.js'
import {
  getHkcuSettings,
  getMdmSettings,
  getWslInherits,
} from './mdm/settings.js'
import {
  getCachedAdminPolicyLoadErrors,
  getCachedParsedFile,
  getCachedPolicySettingsLoadErrors,
  getCachedPolicySettingsOrigin,
  getCachedSettingsForSource,
  getCachedSurvivingAdminPolicySource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedAdminPolicyLoadErrors,
  setCachedParsedFile,
  setCachedPolicySettingsLoadErrors,
  setCachedPolicySettingsOrigin,
  setCachedSettingsForSource,
  setCachedSurvivingAdminPolicySource,
  setSessionSettingsCache,
} from './settingsCache.js'
import { publishSettingsChange } from './settingsChangeSignal.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import {
  filterSettingsWarnings,
  formatZodError,
  ManagedSettingsSchema,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

function cloneAndFilterSettingsWarnings(
  settings: SettingsJson,
  sourceName: string,
): { settings: SettingsJson; warnings: ValidationError[] } {
  const filteredSettings = clone(settings)
  const warnings = filterSettingsWarnings(filteredSettings, sourceName)
  return { settings: filteredSettings, warnings }
}

/**
 * Get the path to the managed settings file based on the current platform
 */
function getManagedSettingsFilePath(): string {
  return join(getManagedFilePath(), 'managed-settings.json')
}

/**
 * Load file-based managed settings: managed-settings.json + managed-settings.d/*.json.
 *
 * managed-settings.json is merged first (lowest precedence / base), then drop-in
 * files are sorted alphabetically and merged on top (higher precedence, later
 * files win). This matches the systemd/sudoers drop-in convention: the base
 * file provides defaults, drop-ins customize. Separate teams can ship
 * independent policy fragments (e.g. 10-otel.json, 20-security.json) without
 * coordinating edits to a single admin-owned file.
 *
 * Exported for testing.
 */
/**
 * 118 `D28` — load managed-settings.json + drop-ins from a directory.
 * Emptiness ignores `wslInheritsWindowsSettings` so a flag-only file
 * does not win the policy chain.
 */
function loadManagedFileSettingsFromDir(dir: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const errors: ValidationError[] = []
  let merged: SettingsJson = {}
  let found = false

  const { settings, errors: baseErrors } = parseSettingsFile(
    join(dir, 'managed-settings.json'),
    undefined,
    true,
  )
  errors.push(...baseErrors)
  if (settings && Object.keys(settings).length > 0) {
    merged = mergeWith(merged, settings, settingsMergeCustomizer)
    found = true
  }

  const dropInDir = join(dir, 'managed-settings.d')
  try {
    const entries = getFsImplementation()
      .readdirSync(dropInDir)
      .filter(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
      .map(d => d.name)
      .sort()
    for (const name of entries) {
      const { settings, errors: fileErrors } = parseSettingsFile(
        join(dropInDir, name),
        undefined,
        true,
      )
      errors.push(...fileErrors)
      if (settings && Object.keys(settings).length > 0) {
        merged = mergeWith(merged, settings, settingsMergeCustomizer)
        found = true
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logError(e)
    }
  }

  const { wslInheritsWindowsSettings: _flag, ...remainder } = merged
  return {
    settings: found && Object.keys(remainder).length > 0 ? merged : null,
    errors,
  }
}

/**
 * 118 `AW$`: WSL + inherit prefers `C:/Program Files/ClaudeCode` via DrvFs.
 */
export function loadManagedFileSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  if (getPlatform() === 'wsl' && getWslInherits()) {
    const windows = loadManagedFileSettingsFromDir(WSL_WINDOWS_MANAGED_DIR)
    if (windows.settings) {
      return windows
    }
    const linux = loadManagedFileSettingsFromDir(getManagedFilePath())
    return {
      settings: linux.settings,
      errors: [...windows.errors, ...linux.errors],
    }
  }
  return loadManagedFileSettingsFromDir(getManagedFilePath())
}

/**
 * Check which file-based managed settings sources are present.
 * Used by /status to show "(file)", "(drop-ins)", or "(file + drop-ins)".
 */
export function getManagedFileSettingsPresence(): {
  hasBase: boolean
  hasDropIns: boolean
} {
  // 118 `X28`: WSL inherit checks Windows dir first.
  const dirs = [getManagedFilePath()]
  if (getPlatform() === 'wsl' && getWslInherits()) {
    dirs.unshift(WSL_WINDOWS_MANAGED_DIR)
  }
  for (const dir of dirs) {
    const { settings: base } = parseSettingsFile(
      join(dir, 'managed-settings.json'),
      undefined,
      true,
    )
    const { wslInheritsWindowsSettings: _flag, ...remainder } = base ?? {}
    const hasBase = Object.keys(remainder).length > 0
    let hasDropIns = false
    try {
      const dropInDir = join(dir, 'managed-settings.d')
      hasDropIns = getFsImplementation()
        .readdirSync(dropInDir)
        .some(d => {
          if (
            !(d.isFile() || d.isSymbolicLink()) ||
            !d.name.endsWith('.json') ||
            d.name.startsWith('.')
          ) {
            return false
          }
          const { settings } = parseSettingsFile(
            join(dropInDir, d.name),
            undefined,
            true,
          )
          const { wslInheritsWindowsSettings: _dropFlag, ...rest } =
            settings ?? {}
          return Object.keys(rest).length > 0
        })
    } catch {
      // dir doesn't exist
    }
    if (hasBase || hasDropIns) {
      return { hasBase, hasDropIns }
    }
  }
  return { hasBase: false, hasDropIns: false }
}

/** 118 `J28` — SDK parent `--managed-settings` blob. */
function loadParentManagedSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const raw = getParentManagedSettings()
  if (!raw || Object.keys(raw).length === 0) {
    return { settings: null, errors: [] }
  }
  const cloned = clone(raw)
  const warnings = filterSettingsWarnings(cloned, 'parent managed settings')
  const parsed = SettingsSchema().safeParse(cloned)
  if (!parsed.success) {
    return {
      settings: null,
      errors: [
        ...warnings,
        ...formatZodError(parsed.error, 'parent managed settings'),
      ],
    }
  }
  return Object.keys(parsed.data).length > 0
    ? { settings: parsed.data, errors: warnings }
    : { settings: null, errors: warnings }
}

/**
 * Handles file system errors appropriately
 * @param error The error to handle
 * @param path The file path that caused the error
 */
function handleFileSystemError(error: unknown, path: string): void {
  if (
    typeof error === 'object' &&
    error &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    logForDebugging(
      `Broken symlink or missing file encountered for settings.json at path: ${path}`,
    )
  } else {
    logError(error)
  }
}

/**
 * Parses a settings file into a structured format
 * @param path The path to the permissions file
 * @param source The source of the settings (optional, for error reporting)
 * @returns Parsed settings data and validation errors
 */
export function parseSettingsFile(
  path: string,
  content?: string,
  isManaged = false,
): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(path)
  if (cached) {
    // Clone so callers (e.g. mergeWith in getSettingsForSourceUncached,
    // updateSettingsForSource) can't mutate the cached entry.
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    }
  }
  const result = parseSettingsFileUncached(path, content, isManaged)
  setCachedParsedFile(path, result)
  // Clone the first return too — the caller may mutate before
  // another caller reads the same cache entry.
  return {
    settings: result.settings ? clone(result.settings) : null,
    errors: result.errors,
  }
}

function parseSettingsFileUncached(
  path: string,
  content?: string,
  isManaged = false,
): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  try {
    let fileContent: string
    if (content !== undefined) {
      fileContent = content
    } else {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), path)
      fileContent = readFileSync(resolvedPath)
    }

    if (fileContent.trim() === '') {
      return { settings: {}, errors: [] }
    }

    const data = safeParseJSON(fileContent, false)

    if (isManaged) {
      // Official 2.1.166 `c86`: validate managed settings field-by-field so
      // one invalid field no longer silently disables the remaining valid
      // policies. MCP entry filtering happens via the per-entry catch below.
      const ruleWarnings = filterSettingsWarnings(data, path, {
        skipMcpServerEntryFilter: true,
      })
      const fieldWarnings: ValidationError[] = []
      const result = ManagedSettingsSchema(issue =>
        fieldWarnings.push({
          file: path,
          path: issue.path,
          message: issue.message,
          severity: 'warning',
        }),
      ).safeParse(data)
      if (!result.success) {
        return {
          settings: null,
          errors: [...ruleWarnings, ...formatZodError(result.error, path)],
        }
      }
      return { settings: result.data, errors: [...ruleWarnings, ...fieldWarnings] }
    }

    // Filter invalid permission rules before schema validation so one bad
    // rule doesn't cause the entire settings file to be rejected.
    const ruleWarnings = filterSettingsWarnings(data, path)

    const result = SettingsSchema().safeParse(data)

    if (!result.success) {
      const errors = formatZodError(result.error, path)
      return { settings: null, errors: [...ruleWarnings, ...errors] }
    }

    return { settings: result.data, errors: ruleWarnings }
  } catch (error) {
    handleFileSystemError(error, path)
    return { settings: null, errors: [] }
  }
}

/**
 * Get the absolute path to the associated file root for a given settings source
 * (e.g. for $PROJ_DIR/.claude/settings.json, returns $PROJ_DIR)
 * @param source The source of the settings
 * @returns The root path of the settings file
 */
export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings': {
      return resolve(getOriginalCwd())
    }
    case 'flagSettings': {
      const path = getFlagSettingsPath()
      return path ? dirname(resolve(path)) : resolve(getOriginalCwd())
    }
  }
}

/**
 * Get the user settings filename based on cowork mode.
 * Returns 'cowork_settings.json' when in cowork mode, 'settings.json' otherwise.
 *
 * Priority:
 * 1. Session state (set by CLI flag --cowork)
 * 2. Environment variable CLAUDE_CODE_USE_COWORK_PLUGINS
 * 3. Default: 'settings.json'
 */
function getUserSettingsFilePath(): string {
  if (
    getUseCoworkPlugins() ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)
  ) {
    return 'cowork_settings.json'
  }
  return 'settings.json'
}

export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(
        getSettingsRootPathForSource(source),
        getUserSettingsFilePath(),
      )
    case 'projectSettings':
    case 'localSettings': {
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    }
    case 'policySettings':
      return getManagedSettingsFilePath()
    case 'flagSettings': {
      return getFlagSettingsPath()
    }
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings':
      return join('.claude', 'settings.json')
    case 'localSettings':
      return join('.claude', 'settings.local.json')
  }
}

export function getSettingsForSource(
  source: SettingSource,
): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const result = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, result)
  return result
}

/**
 * Official 2.1.176 `Jf6`. Collect a setting from policy, flag, and user
 * sources only — project `.claude/settings.json` and local
 * `.claude/settings.local.json` are skipped. Used for `footerLinksRegexes`
 * (schema describe: user, flag, and managed only).
 */
export function getSettingsFromUserFlagAndPolicy<K extends keyof SettingsJson>(
  key: K,
): Array<NonNullable<SettingsJson[K]>> {
  const values: Array<NonNullable<SettingsJson[K]>> = []
  for (const source of [
    'policySettings',
    'flagSettings',
    'userSettings',
  ] as const) {
    const value = getSettingsForSource(source)?.[key]
    if (value !== undefined) {
      values.push(value as NonNullable<SettingsJson[K]>)
    }
  }
  return values
}

/**
 * Official 2.1.126 `CD9` / `OH$`: every managed-settings source that actually
 * loaded, not first-wins `policySettings`. Used so `allowManagedDomainsOnly`
 * / `allowManagedReadPathsOnly` still apply when a higher-priority source
 * lacks a `sandbox` block. Order matches the policy chain without HKCU:
 * remote, MDM (HKLM/plist), file+drop-ins, parent.
 */
export function getAllManagedSettingsSources(): SettingsJson[] {
  const sources: SettingsJson[] = []

  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    const filtered = cloneAndFilterSettingsWarnings(
      remoteSettings,
      'remote managed settings',
    ).settings
    if (Object.keys(filtered).length > 0) {
      sources.push(filtered)
    }
  }

  const mdm = getMdmSettings()
  if (Object.keys(mdm.settings).length > 0) {
    sources.push(mdm.settings)
  }

  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    sources.push(fileSettings)
  }

  const { settings: parentSettings } = loadParentManagedSettings()
  if (parentSettings) {
    sources.push(parentSettings)
  }

  return sources
}

/**
 * Highest-priority enabled source that actually defines `key`.
 * Official 2.1.117 Q3H — used by /model pin chrome and persist.
 */
export function getSourceForSetting(
  key: keyof SettingsJson,
): SettingSource | null {
  const sources = getEnabledSettingSources()
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]
    if (source && getSettingsForSource(source)?.[key] !== undefined) {
      return source
    }
  }
  return null
}

function getSettingsForSourceUncached(
  source: SettingSource,
): SettingsJson | null {
  // For policySettings: first source wins (remote > HKLM/plist > file > parent > HKCU)
  if (source === 'policySettings') {
    const remoteSettings = getRemoteManagedSettingsSyncFromCache()
    if (remoteSettings && Object.keys(remoteSettings).length > 0) {
      const filtered = cloneAndFilterSettingsWarnings(
        remoteSettings,
        'remote managed settings',
      ).settings
      if (Object.keys(filtered).length > 0) {
        return filtered
      }
    }

    const mdmResult = getMdmSettings()
    if (Object.keys(mdmResult.settings).length > 0) {
      return mdmResult.settings
    }

    const { settings: fileSettings } = loadManagedFileSettings()
    if (fileSettings) {
      return fileSettings
    }

    // 118: parent managed settings after file, before HKCU
    const { settings: parentSettings } = loadParentManagedSettings()
    if (parentSettings) {
      return parentSettings
    }

    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) {
      return hkcu.settings
    }

    return null
  }

  const settingsFilePath = getSettingsFilePathForSource(source)
  const { settings: fileSettings } = settingsFilePath
    ? parseSettingsFile(settingsFilePath)
    : { settings: null }

  // For flagSettings, merge in any inline settings set via the SDK
  if (source === 'flagSettings') {
    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const filteredInline = cloneAndFilterSettingsWarnings(
        inlineSettings,
        'inline flag settings',
      ).settings
      const parsed = SettingsSchema().safeParse(filteredInline)
      if (parsed.success) {
        return mergeWith(
          fileSettings || {},
          parsed.data,
          settingsMergeCustomizer,
        ) as SettingsJson
      }
    }
  }

  return fileSettings
}

/**
 * Get the origin of the highest-priority active policy settings source.
 * Uses "first source wins" — returns the first source that has content.
 * Priority: remote > plist/hklm > file (managed-settings.json) > parent > hkcu
 */
export function getBasePolicySettingsOrigin():
  | 'plist'
  | 'hklm'
  | 'file'
  | 'parent'
  | 'hkcu'
  | null {
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return 'remote' as any
  }

  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return getPlatform() === 'macos' ? 'plist' : 'hklm'
  }

  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    return 'file'
  }

  const { settings: parentSettings } = loadParentManagedSettings()
  if (parentSettings) {
    return 'parent'
  }

  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) {
    return 'hkcu'
  }

  return null
}

export function getPolicySettingsOrigin():
  | 'remote'
  | 'plist'
  | 'hklm'
  | 'file'
  | 'parent'
  | 'hkcu'
  | null {
  const cached = getCachedPolicySettingsOrigin()
  if (cached !== undefined) {
    return cached.value as any
  }
  const origin = getBasePolicySettingsOrigin()
  setCachedPolicySettingsOrigin(origin)
  return origin
}

/**
 * Official 2.1.166 `_3$` / 2.1.175 `Lj$` — validation errors from every managed policy
 * source: remote, MDM (plist/HKLM), file-based managed settings, parent managed
 * settings, and HKCU.
 */
export function getPolicySettingsLoadErrors(): ValidationError[] {
  const cached = getCachedPolicySettingsLoadErrors()
  if (cached !== undefined) return cached

  const errors: ValidationError[] = []
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    const filteredRemote = cloneAndFilterSettingsWarnings(
      remoteSettings,
      'remote managed settings',
    )
    errors.push(...filteredRemote.warnings)
    const result = SettingsSchema().safeParse(filteredRemote.settings)
    if (!result.success) {
      errors.push(...formatZodError(result.error, 'remote managed settings'))
    }
  }
  errors.push(...getMdmSettings().errors)
  errors.push(...loadManagedFileSettings().errors)
  errors.push(...loadParentManagedSettings().errors)
  errors.push(...getHkcuSettings().errors)
  setCachedPolicySettingsLoadErrors(errors)
  return errors
}

/**
 * Official 2.1.175 `Uiq` — validation errors from admin policy sources only:
 * remote, MDM (plist/HKLM), and file-based managed settings (excludes parent and HKCU).
 */
export function getAdminPolicyLoadErrors(): ValidationError[] {
  const cached = getCachedAdminPolicyLoadErrors()
  if (cached !== undefined) return cached

  const errors: ValidationError[] = []
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    const filteredRemote = cloneAndFilterSettingsWarnings(
      remoteSettings,
      'remote managed settings',
    )
    errors.push(...filteredRemote.warnings)
    const result = SettingsSchema().safeParse(filteredRemote.settings)
    if (!result.success) {
      errors.push(...formatZodError(result.error, 'remote managed settings'))
    }
  }
  errors.push(...getMdmSettings().errors)
  errors.push(...loadManagedFileSettings().errors)
  setCachedAdminPolicyLoadErrors(errors)
  return errors
}

/** Official 2.1.175 `Fiq` — filter out non-fatal warnings from policy validation errors. */
export function filterFatalPolicyErrors(
  errors: ValidationError[],
): ValidationError[] {
  return errors.filter(error => error.severity !== 'warning')
}

/** Official 2.1.175 `Pj$` — fatal validation errors from admin policy sources. */
export function getFatalAdminPolicyLoadErrors(): ValidationError[] {
  return filterFatalPolicyErrors(getAdminPolicyLoadErrors())
}

/** Official 2.1.175 `Wj$` — check if any admin policy source loaded with non-empty settings. */
export function hasSurvivingAdminPolicySource(): boolean {
  const cached = getCachedSurvivingAdminPolicySource()
  if (cached !== undefined) return cached

  const hasContent = (val: unknown): boolean =>
    val != null && typeof val === 'object' && Object.keys(val).length > 0

  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  const mdm = getMdmSettings()
  const { settings: fileSettings } = loadManagedFileSettings()

  const result = Boolean(
    hasContent(remoteSettings) ||
      hasContent(mdm.settings) ||
      hasContent(fileSettings),
  )
  setCachedSurvivingAdminPolicySource(result)
  return result
}

/**
 * Official 2.1.166 `H66` / 2.1.175 `p_6` — print managed-settings validation problems to
 * stderr at startup (headless surface). Fatal errors (missing severity, i.e.
 * the whole source failed) mean that source's policies are NOT in effect;
 * warnings mean invalid entries were dropped but remaining valid policies
 * are still enforced.
 */
export function surfaceManagedSettingsErrorsHeadless(): void {
  const errors = getPolicySettingsLoadErrors()
  if (errors.length === 0) return
  const fatal = errors.some(error => error.severity !== 'warning')
  const header = fatal
    ? 'Managed settings failed to load; policies from the failed source are NOT in effect:'
    : 'Managed settings contain invalid entries (remaining valid policies are still enforced):'
  const lines = errors.map(
    error =>
      `  ${error.file ?? 'managed settings'}${error.path ? ` (${error.path})` : ''}: ${error.message}`,
  )
  process.stderr.write(`${header}\n${lines.join('\n')}\n`)
  logEvent('tengu_managed_settings_validation_errors', {
    error_count: errors.length,
    remote_error_count: errors.filter(
      e => e.file === 'remote managed settings',
    ).length,
    fatal,
  })
}

/**
 * Merges `settings` into the existing settings for `source` using lodash mergeWith.
 *
 * To delete a key from a record field (e.g. enabledPlugins, extraKnownMarketplaces),
 * set it to `undefined` — do NOT use `delete`. mergeWith only detects deletion when
 * the key is present with an explicit `undefined` value.
 */
export function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if (
    (source as unknown) === 'policySettings' ||
    (source as unknown) === 'flagSettings'
  ) {
    return { error: null }
  }

  // Create the folder if needed
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { error: null }
  }

  try {
    getFsImplementation().mkdirSync(dirname(filePath))

    // Try to get existing settings with validation. Bypass the per-source
    // cache — mergeWith below mutates its target (including nested refs),
    // and mutating the cached object would leak unpersisted state if the
    // write fails before resetSettingsCache().
    let existingSettings = getSettingsForSourceUncached(source)

    // If validation failed, check if file exists with a JSON syntax error
    if (!existingSettings) {
      let content: string | null = null
      try {
        content = readFileSync(filePath)
      } catch (e) {
        if (!isENOENT(e)) {
          throw e
        }
        // File doesn't exist — fall through to merge with empty settings
      }
      if (content !== null) {
        const rawData = safeParseJSON(content)
        if (rawData === null) {
          // JSON syntax error - return validation error instead of overwriting
          // safeParseJSON will already log the error, so we'll just return the error here
          return {
            error: new Error(
              `Invalid JSON syntax in settings file at ${filePath}`,
            ),
          }
        }
        if (rawData && typeof rawData === 'object') {
          existingSettings = rawData as SettingsJson
          logForDebugging(
            `Using raw settings from ${filePath} due to validation failure`,
          )
        }
      }
    }

    const updatedSettings = mergeWith(
      existingSettings || {},
      settings,
      (
        _objValue: unknown,
        srcValue: unknown,
        key: string | number | symbol,
        object: Record<string | number | symbol, unknown>,
      ) => {
        // Handle undefined as deletion
        if (srcValue === undefined && object && typeof key === 'string') {
          delete object[key]
          return undefined
        }
        // For arrays, always replace with the provided array
        // This puts the responsibility on the caller to compute the desired final state
        if (Array.isArray(srcValue)) {
          return srcValue
        }
        // For non-arrays, let lodash handle the default merge behavior
        return undefined
      },
    )

    // Mark this as an internal write before writing the file
    markInternalWrite(filePath)

    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(updatedSettings, null, 2) + '\n',
    )

    // Apply the fresh settings and permission snapshots immediately. The
    // watcher consumes the internal-write marker, so this is the only fan-out.
    publishSettingsChange(source)

    if (source === 'localSettings') {
      // Okay to add to gitignore async without awaiting
      void addFileGlobRuleToGitignore(
        getRelativeSettingsFilePathForSource('localSettings'),
        getOriginalCwd(),
      )
    }
  } catch (e) {
    const error = new Error(
      `Failed to read raw settings from ${filePath}: ${e}`,
    )
    logError(error)
    return { error }
  }

  return { error: null }
}

/**
 * Custom merge function for arrays - concatenate and deduplicate
 */
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

/**
 * Custom merge function for lodash mergeWith when merging settings.
 * Arrays are concatenated and deduplicated; other values use default lodash merge behavior.
 * Exported for testing.
 *
 * Official 2.1.166 `z$H`: `fallbackModel` overrides instead of concatenating
 * across sources — the more specific source's fallback list wins whole.
 */
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
  key?: string,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    if (key === 'fallbackModel') {
      return srcValue
    }
    return mergeArrays(objValue, srcValue)
  }
  // Return undefined to let lodash handle default merge behavior
  return undefined
}

/**
 * Get a list of setting keys from managed settings for logging purposes.
 * For certain nested settings (permissions, sandbox, hooks), expands to show
 * one level of nesting (e.g., "permissions.allow"). For other settings,
 * returns only the top-level key.
 *
 * @param settings The settings object to extract keys from
 * @returns Sorted array of key paths
 */
export function getManagedSettingsKeysForLogging(
  settings: SettingsJson,
): string[] {
  // Use .strip() to get only valid schema keys
  const validSettings = SettingsSchema().strip().parse(settings) as Record<
    string,
    unknown
  >
  const keysToExpand = ['permissions', 'sandbox', 'hooks']
  const allKeys: string[] = []

  // Define valid nested keys for each nested setting we expand
  const validNestedKeys: Record<string, Set<string>> = {
    permissions: new Set([
      'allow',
      'deny',
      'ask',
      'defaultMode',
      'disableBypassPermissionsMode',
      ...(feature('TRANSCRIPT_CLASSIFIER') ? ['disableAutoMode'] : []),
      'additionalDirectories',
    ]),
    sandbox: new Set([
      'enabled',
      'failIfUnavailable',
      'allowUnsandboxedCommands',
      'network',
      'filesystem',
      'ignoreViolations',
      'excludedCommands',
      'autoAllowBashIfSandboxed',
      'enableWeakerNestedSandbox',
      'enableWeakerNetworkIsolation',
      'ripgrep',
    ]),
    // For hooks, we use z.record with enum keys, so we validate separately
    hooks: new Set([
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'UserPromptSubmit',
      'UserPromptExpansion',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
    ]),
  }

  for (const key of Object.keys(validSettings)) {
    if (
      keysToExpand.includes(key) &&
      validSettings[key] &&
      typeof validSettings[key] === 'object'
    ) {
      // Expand nested keys for these special settings (one level deep only)
      const nestedObj = validSettings[key] as Record<string, unknown>
      const validKeys = validNestedKeys[key]

      if (validKeys) {
        for (const nestedKey of Object.keys(nestedObj)) {
          // Only include known valid nested keys
          if (validKeys.has(nestedKey)) {
            allKeys.push(`${key}.${nestedKey}`)
          }
        }
      }
    } else {
      // For other settings, just use the top-level key
      allKeys.push(key)
    }
  }

  return allKeys.sort()
}

// Flag to prevent infinite recursion when loading settings
let isLoadingSettings = false

/**
 * Load settings from disk without using cache
 * This is the original implementation that actually reads from files
 */
function loadSettingsFromDisk(): SettingsWithErrors {
  // Prevent recursive calls to loadSettingsFromDisk
  if (isLoadingSettings) {
    return { settings: {}, errors: [] }
  }

  const startTime = Date.now()
  profileCheckpoint('loadSettingsFromDisk_start')
  logForDiagnosticsNoPII('info', 'settings_load_started')

  isLoadingSettings = true
  try {
    // Start with plugin settings as the lowest priority base.
    // All file-based sources (user, project, local, flag, policy) override these.
    // Plugin settings only contain allowlisted keys (e.g., agent) that are valid SettingsJson fields.
    const pluginSettings = getPluginSettingsBase()
    let mergedSettings: SettingsJson = {}
    if (pluginSettings) {
      mergedSettings = mergeWith(
        mergedSettings,
        pluginSettings,
        settingsMergeCustomizer,
      )
    }
    const allErrors: ValidationError[] = []
    const seenErrors = new Set<string>()
    const seenFiles = new Set<string>()
    let policySettingsSnapshot: SettingsJson | null = null

    // Merge settings from each source in priority order with deep merging
    for (const source of getEnabledSettingSources()) {
      // policySettings: "first source wins" — use the highest-priority source
      // that has content. Priority: remote > HKLM/plist > managed-settings.json > parent > HKCU
      if (source === 'policySettings') {
        let policySettings: SettingsJson | null = null
        const policyErrors: ValidationError[] = []

        // 1. Remote (highest priority)
        const remoteSettings = getRemoteManagedSettingsSyncFromCache()
        if (remoteSettings && Object.keys(remoteSettings).length > 0) {
          const filteredRemote = cloneAndFilterSettingsWarnings(
            remoteSettings,
            'remote managed settings',
          )
          policyErrors.push(...filteredRemote.warnings)
          const result = SettingsSchema().safeParse(filteredRemote.settings)
          if (result.success && Object.keys(result.data).length > 0) {
            policySettings = result.data
          } else {
            // Remote exists but is invalid — surface errors even as we fall through
            policyErrors.push(
              ...formatZodError(result.error, 'remote managed settings'),
            )
          }
        }

        // 2. Admin-only MDM (HKLM / macOS plist)
        if (!policySettings) {
          const mdmResult = getMdmSettings()
          if (Object.keys(mdmResult.settings).length > 0) {
            policySettings = mdmResult.settings
          }
          policyErrors.push(...mdmResult.errors)
        }

        // 3. managed-settings.json + managed-settings.d/ (file-based, requires admin)
        if (!policySettings) {
          const { settings, errors } = loadManagedFileSettings()
          if (settings) {
            policySettings = settings
          }
          policyErrors.push(...errors)
        }

        // 4. SDK parent `--managed-settings` (118 `J28`, after file, before HKCU)
        if (!policySettings) {
          const { settings, errors } = loadParentManagedSettings()
          if (settings) {
            policySettings = settings
          }
          policyErrors.push(...errors)
        }

        // 5. HKCU (lowest — user-writable, only if nothing above exists)
        if (!policySettings) {
          const hkcu = getHkcuSettings()
          if (Object.keys(hkcu.settings).length > 0) {
            policySettings = hkcu.settings
          }
          policyErrors.push(...hkcu.errors)
        }

        // Merge the winning policy source into the settings chain
        policySettingsSnapshot = policySettings
        if (policySettings) {
          mergedSettings = mergeWith(
            mergedSettings,
            policySettings,
            settingsMergeCustomizer,
          )
        }
        for (const error of policyErrors) {
          const errorKey = `${error.file}:${error.path}:${error.message}`
          if (!seenErrors.has(errorKey)) {
            seenErrors.add(errorKey)
            allErrors.push(error)
          }
        }

        continue
      }

      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)

        // Skip if we've already loaded this file from another source
        if (!seenFiles.has(resolvedPath)) {
          seenFiles.add(resolvedPath)

          const { settings, errors } = parseSettingsFile(filePath)

          // Add unique errors (deduplication)
          for (const error of errors) {
            const errorKey = `${error.file}:${error.path}:${error.message}`
            if (!seenErrors.has(errorKey)) {
              seenErrors.add(errorKey)
              allErrors.push(error)
            }
          }

          if (settings) {
            mergedSettings = mergeWith(
              mergedSettings,
              settings,
              settingsMergeCustomizer,
            )
          }
        }
      }

      // For flagSettings, also merge any inline settings set via the SDK
      if (source === 'flagSettings') {
        const inlineSettings = getFlagSettingsInline()
        if (inlineSettings) {
          const filteredInline = cloneAndFilterSettingsWarnings(
            inlineSettings,
            'inline flag settings',
          )
          for (const warning of filteredInline.warnings) {
            const warningKey = `${warning.file}:${warning.path}:${warning.message}`
            if (!seenErrors.has(warningKey)) {
              seenErrors.add(warningKey)
              allErrors.push(warning)
            }
          }
          const parsed = SettingsSchema().safeParse(filteredInline.settings)
          if (parsed.success) {
            mergedSettings = mergeWith(
              mergedSettings,
              parsed.data,
              settingsMergeCustomizer,
            )
          } else {
            for (const error of formatZodError(
              parsed.error,
              'inline flag settings',
            )) {
              const errorKey = `${error.file}:${error.path}:${error.message}`
              if (!seenErrors.has(errorKey)) {
                seenErrors.add(errorKey)
                allErrors.push(error)
              }
            }
          }
        }
      }
    }

    if (policySettingsSnapshot) {
      if (policySettingsSnapshot.availableModels !== undefined) {
        mergedSettings.availableModels = [...policySettingsSnapshot.availableModels]
      }
      if (policySettingsSnapshot.enforceAvailableModels !== undefined) {
        mergedSettings.enforceAvailableModels = policySettingsSnapshot.enforceAvailableModels
      }
    }

    logForDiagnosticsNoPII('info', 'settings_load_completed', {
      duration_ms: Date.now() - startTime,
      source_count: seenFiles.size,
      error_count: allErrors.length,
    })

    return { settings: mergedSettings, errors: allErrors }
  } finally {
    isLoadingSettings = false
  }
}

/**
 * Get merged settings from all sources in priority order
 * Settings are merged from lowest to highest priority:
 * userSettings -> projectSettings -> localSettings -> policySettings
 *
 * This function returns a snapshot of settings at the time of call.
 * For React components, prefer using useSettings() hook for reactive updates
 * when settings change on disk.
 *
 * Uses session-level caching to avoid repeated file I/O.
 * Cache is invalidated when settings files change via resetSettingsCache().
 *
 * @returns Merged settings from all available sources (always returns at least empty object)
 */
export function getInitialSettings(): SettingsJson {
  const { settings } = getSettingsWithErrors()
  return settings || {}
}

/**
 * @deprecated Use getInitialSettings() instead. This alias exists for backwards compatibility.
 */
export const getSettings_DEPRECATED = getInitialSettings

export type SettingsWithSources = {
  effective: SettingsJson
  /** Ordered low-to-high priority — later entries override earlier ones. */
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * Get the effective merged settings alongside the raw per-source settings,
 * in merge-priority order. Only includes sources that are enabled and have
 * non-empty content.
 *
 * Always reads fresh from disk — resets the session cache so that `effective`
 * and `sources` are consistent even if the change detector hasn't fired yet.
 */
export function getSettingsWithSources(): SettingsWithSources {
  // Reset both caches so getSettingsForSource (per-source cache) and
  // getInitialSettings (session cache) agree on the current disk state.
  resetSettingsCache()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective: getInitialSettings(), sources }
}

/**
 * Get merged settings and validation errors from all sources
 * This function now uses session-level caching to avoid repeated file I/O.
 * Settings changes require Claude Code restart, so cache is valid for entire session.
 * @returns Merged settings and all validation errors encountered
 */
export function getSettingsWithErrors(): SettingsWithErrors {
  // Use cached result if available
  const cached = getSessionSettingsCache()
  if (cached !== null) {
    return cached
  }

  // Load from disk and cache the result
  const result = loadSettingsFromDisk()
  profileCheckpoint('loadSettingsFromDisk_end')
  setSessionSettingsCache(result)
  return result
}

/**
 * Check if any raw settings file contains a specific key, regardless of validation.
 * This is useful for detecting user intent even when settings validation fails.
 * For example, if a user set cleanupPeriodDays but has validation errors elsewhere,
 * we can detect they explicitly configured cleanup and skip cleanup rather than
 * falling back to defaults.
 */
/**
 * Returns true if any trusted settings source has accepted the bypass
 * permissions mode dialog. projectSettings is intentionally excluded —
 * a malicious project could otherwise auto-bypass the dialog (RCE risk).
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('localSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('flagSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('policySettings')?.skipDangerousModePermissionPrompt
  )
}

/**
 * Official 2.1.153 `xF$` — any trusted source has accepted the workflow
 * usage warning. projectSettings is excluded (same RCE posture as the
 * dangerous-mode twin).
 */
export function hasSkipWorkflowUsageWarning(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipWorkflowUsageWarning ||
    getSettingsForSource('localSettings')?.skipWorkflowUsageWarning ||
    getSettingsForSource('flagSettings')?.skipWorkflowUsageWarning ||
    getSettingsForSource('policySettings')?.skipWorkflowUsageWarning
  )
}

/**
 * Returns true if any trusted settings source has accepted the auto
 * mode opt-in dialog. projectSettings is intentionally excluded —
 * a malicious project could otherwise auto-bypass the dialog (RCE risk).
 */
export function hasAutoModeOptIn(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const user = getSettingsForSource('userSettings')?.skipAutoPermissionPrompt
    const local =
      getSettingsForSource('localSettings')?.skipAutoPermissionPrompt
    const flag = getSettingsForSource('flagSettings')?.skipAutoPermissionPrompt
    const policy =
      getSettingsForSource('policySettings')?.skipAutoPermissionPrompt
    const result = !!(user || local || flag || policy)
    logForDebugging(
      `[auto-mode] hasAutoModeOptIn=${result} skipAutoPermissionPrompt: user=${user} local=${local} flag=${flag} policy=${policy}`,
    )
    return result
  }
  return false
}

/**
 * Returns whether plan mode should use auto mode semantics. Default true
 * (opt-out). Returns false if any trusted source explicitly sets false.
 * projectSettings is excluded so a malicious project can't control this.
 */
export function getUseAutoModeDuringPlan(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      getSettingsForSource('policySettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('flagSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('userSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('localSettings')?.useAutoModeDuringPlan !== false
    )
  }
  return true
}

/**
 * Returns the merged autoMode config from trusted settings sources.
 * Only available when TRANSCRIPT_CLASSIFIER is active; returns undefined otherwise.
 * projectSettings is intentionally excluded — a malicious project could
 * otherwise inject classifier allow/deny rules (RCE risk).
 */
export function getAutoModeConfig():
  | {
      allow?: string[]
      soft_deny?: string[]
      hard_deny?: string[]
      environment?: string[]
    }
  | undefined {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const schema = z.object({
      allow: z.array(z.string()).optional(),
      soft_deny: z.array(z.string()).optional(),
      hard_deny: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      environment: z.array(z.string()).optional(),
    })

    const allow: string[] = []
    const soft_deny: string[] = []
    const hard_deny: string[] = []
    const environment: string[] = []

    for (const source of [
      'userSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      const settings = getSettingsForSource(source)
      if (!settings) continue
      const result = schema.safeParse(
        (settings as Record<string, unknown>).autoMode,
      )
      if (result.success) {
        if (result.data.allow) allow.push(...result.data.allow)
        if (result.data.soft_deny) soft_deny.push(...result.data.soft_deny)
        if (result.data.hard_deny)
          hard_deny.push(...result.data.hard_deny)
        if (process.env.USER_TYPE === 'ant') {
          if (result.data.deny) soft_deny.push(...result.data.deny)
        }
        if (result.data.environment)
          environment.push(...result.data.environment)
      }
    }

    if (
      allow.length > 0 ||
      soft_deny.length > 0 ||
      hard_deny.length > 0 ||
      environment.length > 0
    ) {
      return {
        ...(allow.length > 0 && { allow }),
        ...(soft_deny.length > 0 && { soft_deny }),
        ...(hard_deny.length > 0 && { hard_deny }),
        ...(environment.length > 0 && { environment }),
      }
    }
  }
  return undefined
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    // Skip policySettings - we only care about user-configured settings
    if (source === 'policySettings') {
      continue
    }

    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) {
      continue
    }

    try {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
      const content = readFileSync(resolvedPath)
      if (!content.trim()) {
        continue
      }

      const rawData = safeParseJSON(content, false)
      if (rawData && typeof rawData === 'object' && key in rawData) {
        return true
      }
    } catch (error) {
      // File not found is expected - not all settings files exist
      // Other errors (permissions, I/O) should be tracked
      handleFileSystemError(error, filePath)
    }
  }

  return false
}
