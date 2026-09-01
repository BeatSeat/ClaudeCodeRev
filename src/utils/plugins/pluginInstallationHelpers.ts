/**
 * Shared helper functions for plugin installation
 *
 * This module contains common utilities used across the plugin installation
 * system to reduce code duplication and improve maintainability.
 */

import { randomBytes } from 'crypto'
import { readdir, rename, rm } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getCwd } from '../cwd.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { buildPluginTelemetryFields } from '../telemetry/pluginTelemetry.js'
import { clearAllCaches, markPluginVersionOrphaned } from './cacheUtils.js'
import {
  findOrphanedAutoDeps,
  formatDependencyCountSuffix,
  formatNoMatchingTagError,
  formatOrphanPruneHint,
  formatVersionRequirementError,
  getEnabledPluginIdsForScope,
  intersectConstraints,
  type OrphanAutoScan,
  pluginVersionSatisfies,
  qualifyDependency,
  type ResolutionResult,
  resolveDependencyClosure,
  type VersionRequirementWhy,
} from './dependencyResolver.js'
import {
  addInstalledPlugin,
  getGitCommitSha,
  loadInstalledPluginsV2,
  removePluginInstallation,
} from './installedPluginsManager.js'
import { deletePluginDataDir } from './pluginDirectories.js'
import { deletePluginOptions } from './pluginOptionsStorage.js'
import { getManagedPluginNames } from './managedPlugins.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  getMarketplaceCacheOnly,
  getPluginById,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
  scopeToSettingSource,
} from './pluginIdentifier.js'
import {
  cachePlugin,
  getVersionedCachePath,
  getVersionedZipCachePath,
  loadAllPlugins,
  loadAllPluginsCacheOnly,
} from './pluginLoader.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'
import { calculatePluginVersion } from './pluginVersioning.js'
import {
  isLocalPluginSource,
  type PluginMarketplaceEntry,
  type PluginScope,
  type PluginSource,
} from './schemas.js'
import {
  convertDirectoryToZipInPlace,
  isPluginZipCacheEnabled,
} from './zipCache.js'

/**
 * Plugin installation metadata for installed_plugins.json
 */
export type PluginInstallationInfo = {
  pluginId: string
  installPath: string
  version?: string
}

/**
 * Get current ISO timestamp
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Validate that a resolved path stays within a base directory.
 * Prevents path traversal attacks where malicious paths like './../../../etc/passwd'
 * could escape the expected directory.
 *
 * @param basePath - The base directory that the resolved path must stay within
 * @param relativePath - The relative path to validate
 * @returns The validated absolute path
 * @throws Error if the path would escape the base directory
 */
export function validatePathWithinBase(
  basePath: string,
  relativePath: string,
): string {
  const resolvedPath = resolve(basePath, relativePath)
  const normalizedBase = resolve(basePath) + sep

  // Check if the resolved path starts with the base path
  // Adding sep ensures we don't match partial directory names
  // e.g., /foo/bar should not match /foo/barbaz
  if (
    !resolvedPath.startsWith(normalizedBase) &&
    resolvedPath !== resolve(basePath)
  ) {
    throw new Error(
      `Path traversal detected: "${relativePath}" would escape the base directory`,
    )
  }

  return resolvedPath
}

/** Official 2.1.111: leftover `.claude-plugin-temp-*` from a crashed rename. */
async function removeLeftoverPluginTempDirs(
  parentDir: string | undefined,
): Promise<void> {
  if (!parentDir) return
  let entries: string[]
  try {
    entries = await readdir(parentDir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter(name => name.startsWith('.claude-plugin-temp-'))
      .map(name =>
        rm(join(parentDir, name), { recursive: true, force: true }).catch(
          () => {},
        ),
      ),
  )
}

/**
 * Cache a plugin (local or external) and add it to installed_plugins.json
 *
 * This function combines the common pattern of:
 * 1. Caching a plugin to ~/.claude/plugins/cache/
 * 2. Adding it to the installed plugins registry
 *
 * Both local plugins (with string source like "./path") and external plugins
 * (with object source like {source: "github", ...}) are cached to the same
 * location to ensure consistent behavior.
 *
 * @param pluginId - Plugin ID in "plugin@marketplace" format
 * @param entry - Plugin marketplace entry
 * @param scope - Installation scope (user, project, local, or managed). Defaults to 'user'.
 *                'managed' scope is used for plugins installed automatically from managed settings.
 * @param projectPath - Project path (required for project/local scopes)
 * @param localSourcePath - For local plugins, the resolved absolute path to the source directory
 * @returns Installation path plus plugin.json dependencies (official 2.1.110 `ee6`)
 */
export async function cacheAndRegisterPlugin(
  pluginId: string,
  entry: PluginMarketplaceEntry,
  scope: PluginScope = 'user',
  projectPath?: string,
  localSourcePath?: string,
  auto = false,
): Promise<{
  path: string
  dependencies?: string[]
  depConstraints?: LoadedPlugin['depConstraints']
  defaultEnabled?: boolean
}> {
  // For local plugins, we need the resolved absolute path
  // Cast to PluginSource since cachePlugin handles any string path at runtime
  const source: PluginSource =
    typeof entry.source === 'string' && localSourcePath
      ? (localSourcePath as PluginSource)
      : entry.source

  const cacheResult = await cachePlugin(source, {
    manifest: entry as PluginMarketplaceEntry,
  })

  // Official 2.1.111: recover from an interrupted prior install that left
  // `.claude-plugin-temp-*` behind after a crash mid-rename.
  await removeLeftoverPluginTempDirs(dirname(cacheResult.path))

  // For local plugins, use the original source path for Git SHA calculation
  // because the cached temp directory doesn't have .git (it's copied from a
  // subdirectory of the marketplace git repo). For external plugins, use the
  // cached path. For git-subdir sources, cachePlugin already captured the SHA
  // before discarding the ephemeral clone (the extracted subdir has no .git).
  const pathForGitSha = localSourcePath || cacheResult.path
  const gitCommitSha =
    cacheResult.gitCommitSha ?? (await getGitCommitSha(pathForGitSha))

  const now = getCurrentTimestamp()
  const version = await calculatePluginVersion(
    pluginId,
    entry.source,
    cacheResult.manifest,
    pathForGitSha,
    entry.version,
    cacheResult.gitCommitSha,
  )

  // Move the cached plugin to the versioned path: cache/marketplace/plugin/version/
  const versionedPath = getVersionedCachePath(pluginId, version)
  let finalPath = cacheResult.path

  // Only move if the paths are different and plugin was cached to a different location
  if (cacheResult.path !== versionedPath) {
    // Create the versioned directory structure
    await getFsImplementation().mkdir(dirname(versionedPath))

    // Remove existing versioned path if present (force: no-op if missing)
    await rm(versionedPath, { recursive: true, force: true })

    // Check if versionedPath is a subdirectory of cacheResult.path
    // This happens when marketplace name equals plugin name (e.g., "exa-mcp-server@exa-mcp-server")
    // In this case, we can't directly rename because we'd be moving a directory into itself
    const normalizedCachePath = cacheResult.path.endsWith(sep)
      ? cacheResult.path
      : cacheResult.path + sep
    const isSubdirectory = versionedPath.startsWith(normalizedCachePath)

    if (isSubdirectory) {
      // Move to a temp location first, then to final destination
      // We can't directly rename/copy a directory into its own subdirectory
      // Use the parent of cacheResult.path (same filesystem) to avoid EXDEV
      // errors when /tmp is on a different filesystem (e.g., tmpfs)
      const tempPath = join(
        dirname(cacheResult.path),
        `.claude-plugin-temp-${Date.now()}-${randomBytes(4).toString('hex')}`,
      )
      await rename(cacheResult.path, tempPath)
      await getFsImplementation().mkdir(dirname(versionedPath))
      await rename(tempPath, versionedPath)
    } else {
      // Move the cached plugin to the versioned location
      await rename(cacheResult.path, versionedPath)
    }
    finalPath = versionedPath
  }

  // Zip cache mode: convert directory to ZIP and remove the directory
  if (isPluginZipCacheEnabled()) {
    const zipPath = getVersionedZipCachePath(pluginId, version)
    await convertDirectoryToZipInPlace(finalPath, zipPath)
    finalPath = zipPath
  }

  // Add to both V1 and V2 installed_plugins files with correct scope
  addInstalledPlugin(
    pluginId,
    {
      version,
      installedAt: now,
      lastUpdated: now,
      installPath: finalPath,
      gitCommitSha,
      ...(auto && { auto: true }),
    },
    scope,
    projectPath,
  )

  return {
    path: finalPath,
    dependencies: cacheResult.manifest.dependencies,
    depConstraints: cacheResult.depConstraints,
    defaultEnabled: cacheResult.manifest.defaultEnabled,
  }
}

/**
 * Register a plugin installation without caching
 *
 * Used for local plugins that are already on disk and don't need remote caching.
 * External plugins should use cacheAndRegisterPlugin() instead.
 *
 * @param info - Plugin installation information
 * @param scope - Installation scope (user, project, local, or managed). Defaults to 'user'.
 *                'managed' scope is used for plugins registered from managed settings.
 * @param projectPath - Project path (required for project/local scopes)
 */
export function registerPluginInstallation(
  info: PluginInstallationInfo,
  scope: PluginScope = 'user',
  projectPath?: string,
): void {
  const now = getCurrentTimestamp()
  addInstalledPlugin(
    info.pluginId,
    {
      version: info.version || 'unknown',
      installedAt: now,
      lastUpdated: now,
      installPath: info.installPath,
    },
    scope,
    projectPath,
  )
}

/**
 * Parse plugin ID into components
 *
 * @param pluginId - Plugin ID in "plugin@marketplace" format
 * @returns Parsed components or null if invalid
 */
export function parsePluginId(
  pluginId: string,
): { name: string; marketplace: string } | null {
  const parts = pluginId.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  return {
    name: parts[0],
    marketplace: parts[1],
  }
}

/**
 * Structured result from the install core. Wrappers format messages and
 * handle analytics/error-catching around this.
 */
export type InstallCoreResult =
  | { ok: true; closure: string[]; depNote: string }
  | { ok: false; reason: 'local-source-no-location'; pluginName: string }
  | { ok: false; reason: 'settings-write-failed'; message: string }
  | {
      ok: false
      reason: 'resolution-failed'
      resolution: ResolutionResult & { ok: false }
    }
  | { ok: false; reason: 'blocked-by-policy'; pluginName: string }
  | {
      ok: false
      reason: 'dependency-blocked-by-policy'
      pluginName: string
      blockedDependency: string
    }
  | {
      ok: false
      reason: 'marketplace-blocked-by-policy'
      pluginName: string
      marketplaceName: string
    }
  | {
      ok: false
      reason: 'dependency-marketplace-blocked-by-policy'
      pluginName: string
      blockedDependency: string
      marketplaceName: string
    }
  | {
      ok: false
      reason: 'range-conflict'
      dep: string
      ranges: string[]
      why: VersionRequirementWhy
      installed?: string
    }
  | { ok: false; reason: 'no-matching-tag'; dep: string; range: string }

/**
 * Format a failed ResolutionResult into a user-facing message. Unified on
 * the richer CLI messages (the "Is the X marketplace added?" hint is useful
 * for UI users too).
 */
export function formatResolutionError(
  r: ResolutionResult & { ok: false },
): string {
  switch (r.reason) {
    case 'cycle':
      return `Dependency cycle: ${r.chain.join(' → ')}`
    case 'cross-marketplace': {
      const depMkt = parsePluginIdentifier(r.dependency).marketplace
      const where = depMkt
        ? `marketplace "${depMkt}"`
        : 'a different marketplace'
      const hint = depMkt
        ? ` Add "${depMkt}" to allowCrossMarketplaceDependenciesOn in the ROOT marketplace's marketplace.json (the marketplace of the plugin you're installing — only its allowlist applies; no transitive trust).`
        : ''
      return `Dependency "${r.dependency}" (required by ${r.requiredBy}) is in ${where}, which is not in the allowlist — cross-marketplace dependencies are blocked by default. Install it manually first.${hint}`
    }
    case 'not-found': {
      const { marketplace: depMkt } = parsePluginIdentifier(r.missing)
      return depMkt
        ? `Dependency "${r.missing}" (required by ${r.requiredBy}) not found. Is the "${depMkt}" marketplace added?`
        : `Dependency "${r.missing}" (required by ${r.requiredBy}) not found in any configured marketplace`
    }
  }
}

/**
 * Core plugin install logic, shared by the CLI path (`installPluginOp`) and
 * the interactive UI path (`installPluginFromMarketplace`). Given a
 * pre-resolved marketplace entry, this:
 *
 *   1. Guards against local-source plugins without a marketplace install
 *      location (would silently no-op otherwise).
 *   2. Resolves the transitive dependency closure (when PLUGIN_DEPENDENCIES
 *      is on; trivial single-plugin closure otherwise).
 *   3. Writes the closure to enabledPlugins via xw7 (honors
 *      defaultEnabled; does not force-true every member).
 *   4. Caches each closure member (downloads/copies sources as needed).
 *   5. Clears memoization caches.
 *
 * Returns a structured result. Message formatting, analytics, and top-level
 * error wrapping stay in the caller-specific wrappers.
 *
 * @param marketplaceInstallLocation Pass this if the caller already has it
 *   (from a prior marketplace search) to avoid a redundant lookup.
 */
/**
 * Official 2.1.110 `Y3z`. Marketplace entries may omit `dependencies` that
 * plugin.json declares. Collect those extra IDs so install can auto-install
 * them. Cross-marketplace / missing deps are skipped with a warning (not
 * hard-fail) so a stale catalog cannot block the root install.
 */
async function collectExtraManifestDependencies(params: {
  rootManifestDeps: string[] | undefined
  pluginId: string
  closureSet: Set<string>
  alreadyEnabled: ReadonlySet<string>
  rootMarketplace: string | undefined
  allowedCrossMarketplaces: ReadonlySet<string>
  depInfo: Map<
    string,
    { entry: PluginMarketplaceEntry; marketplaceInstallLocation: string }
  >
}): Promise<
  | { ok: true; ids: string[] }
  | { ok: false; blockedDependency: string }
> {
  const ids: string[] = []
  for (const raw of params.rootManifestDeps ?? []) {
    const dep = qualifyDependency(raw, params.pluginId)
    if (params.closureSet.has(dep) || params.alreadyEnabled.has(dep)) {
      continue
    }
    const depMarketplace = parsePluginIdentifier(dep).marketplace
    if (
      depMarketplace !== params.rootMarketplace &&
      !(depMarketplace && params.allowedCrossMarketplaces.has(depMarketplace))
    ) {
      logForDebugging(
        `${params.pluginId} plugin.json declares dependency "${dep}" in a different marketplace; not auto-installing — install it manually`,
        { level: 'warn' },
      )
      continue
    }
    if (isPluginBlockedByPolicy(dep)) {
      return { ok: false, blockedDependency: dep }
    }
    const info = await getPluginById(dep)
    if (!info) {
      logForDebugging(
        `${params.pluginId} plugin.json declares dependency "${dep}" not found in any known marketplace; not auto-installing`,
        { level: 'warn' },
      )
      continue
    }
    params.depInfo.set(dep, info)
    ids.push(dep)
  }
  return { ok: true, ids }
}

type EnabledPluginSetting = boolean | string[] | undefined

/**
 * Official 2.1.154 `xw7`. Seed enabled ids from prior / explicit /
 * `defaultEnabled ?? true` / root-required-by-dependent, then BFS-enable
 * `dependenciesById` members that are in the closure.
 */
export function solveDefaultEnabled({
  closure,
  rootId,
  rootRequiredByDependent,
  priorEnabled,
  explicitAnywhere,
  defaultsById,
  dependenciesById,
}: {
  closure: readonly string[]
  rootId: string
  rootRequiredByDependent: boolean
  priorEnabled: Readonly<Record<string, EnabledPluginSetting>>
  explicitAnywhere: ReadonlySet<string>
  defaultsById: ReadonlyMap<string, boolean>
  dependenciesById: ReadonlyMap<string, readonly string[]>
}): Map<string, boolean> {
  const inClosure = new Set(closure)
  const enabled = new Set<string>()
  for (const id of closure) {
    const prior = priorEnabled[id]
    const defaultOn = defaultsById.get(id) ?? true
    if (prior !== undefined) {
      if (prior !== false || defaultOn) enabled.add(id)
      continue
    }
    if (
      explicitAnywhere.has(id) ||
      defaultOn ||
      (id === rootId && rootRequiredByDependent)
    ) {
      enabled.add(id)
    }
  }
  const queue = [...enabled]
  while (queue.length > 0) {
    const id = queue.pop()
    if (id === undefined) break
    for (const dep of dependenciesById.get(id) ?? []) {
      if (inClosure.has(dep) && !enabled.has(dep)) {
        enabled.add(dep)
        queue.push(dep)
      }
    }
  }
  return new Map(closure.map(id => [id, enabled.has(id)]))
}

function collectExplicitEnabledPlugins(): {
  explicitAnywhere: Set<string>
  enabledById: Record<string, EnabledPluginSetting>
} {
  const enabledById: Record<string, EnabledPluginSetting> = {}
  for (const source of SETTING_SOURCES) {
    Object.assign(
      enabledById,
      getSettingsForSource(source)?.enabledPlugins ?? {},
    )
  }
  const explicitAnywhere = new Set(
    Object.keys(enabledById).filter(id => enabledById[id] !== undefined),
  )
  return { explicitAnywhere, enabledById }
}

function isPluginEffectivelyEnabled(
  plugin: LoadedPlugin,
  enabledById: Readonly<Record<string, EnabledPluginSetting>>,
): boolean {
  const explicit = enabledById[plugin.source]
  if (explicit !== undefined) {
    return explicit === true || Array.isArray(explicit)
  }
  return plugin.manifest.defaultEnabled !== false
}

function isRootRequiredByEnabledDependent(
  rootId: string,
  loaded: readonly LoadedPlugin[],
  enabledById: Readonly<Record<string, EnabledPluginSetting>>,
): boolean {
  const rootName = parsePluginIdentifier(rootId).name
  return loaded.some(plugin => {
    if (plugin.source === rootId) return false
    if (!isPluginEffectivelyEnabled(plugin, enabledById)) return false
    return (plugin.manifest.dependencies ?? []).some(raw => {
      const dep = qualifyDependency(raw, plugin.source)
      return parsePluginIdentifier(dep).marketplace
        ? dep === rootId
        : dep === rootName
    })
  })
}

export async function installResolvedPlugin({
  pluginId,
  entry,
  scope,
  marketplaceInstallLocation,
}: {
  pluginId: string
  entry: PluginMarketplaceEntry
  scope: 'user' | 'project' | 'local'
  marketplaceInstallLocation?: string
}): Promise<InstallCoreResult> {
  const settingSource = scopeToSettingSource(scope)

  // ── Policy guard ──
  // Org-blocked plugins (managed-settings.json enabledPlugins: false) cannot
  // be installed. Checked here so all install paths (CLI, UI, hint-triggered)
  // are covered in one place.
  if (isPluginBlockedByPolicy(pluginId)) {
    return { ok: false, reason: 'blocked-by-policy', pluginName: entry.name }
  }

  const rootMarketplace = parsePluginIdentifier(pluginId).marketplace
  if (rootMarketplace) {
    const known = await loadKnownMarketplacesConfig()
    const source = known[rootMarketplace]?.source
    if (source && !isSourceAllowedByPolicy(source)) {
      return {
        ok: false,
        reason: 'marketplace-blocked-by-policy',
        pluginName: entry.name,
        marketplaceName: rootMarketplace,
      }
    }
  }

  // ── Resolve dependency closure ──
  // depInfo caches marketplace lookups so the materialize loop doesn't
  // re-fetch. Seed the root if the caller gave us its install location.
  const depInfo = new Map<
    string,
    { entry: PluginMarketplaceEntry; marketplaceInstallLocation: string }
  >()
  // Without this guard, a local-source root with undefined
  // marketplaceInstallLocation falls through: depInfo isn't seeded, the
  // materialize loop's `if (!info) continue` skips the root, and the user
  // sees "Successfully installed" while nothing is cached.
  if (isLocalPluginSource(entry.source) && !marketplaceInstallLocation) {
    return {
      ok: false,
      reason: 'local-source-no-location',
      pluginName: entry.name,
    }
  }
  if (marketplaceInstallLocation) {
    depInfo.set(pluginId, { entry, marketplaceInstallLocation })
  }

  const allowedCrossMarketplaces = new Set(
    (rootMarketplace
      ? (await getMarketplaceCacheOnly(rootMarketplace))
          ?.allowCrossMarketplaceDependenciesOn
      : undefined) ?? [],
  )
  const resolution = await resolveDependencyClosure(
    pluginId,
    async id => {
      if (depInfo.has(id)) return depInfo.get(id)!.entry
      if (id === pluginId) return entry
      const info = await getPluginById(id)
      if (info) depInfo.set(id, info)
      return info?.entry ?? null
    },
    getEnabledPluginIdsForScope(settingSource),
    allowedCrossMarketplaces,
  )
  if (!resolution.ok) {
    return { ok: false, reason: 'resolution-failed', resolution }
  }

  // ── Policy guard for transitive dependencies ──
  // The root plugin was already checked above, but any dependency in the
  // closure could also be policy-blocked. Check before writing to settings
  // so a non-blocked plugin can't pull in a blocked dependency.
  const knownForPolicy = await loadKnownMarketplacesConfig()
  for (const id of resolution.closure) {
    if (id !== pluginId && isPluginBlockedByPolicy(id)) {
      return {
        ok: false,
        reason: 'dependency-blocked-by-policy',
        pluginName: entry.name,
        blockedDependency: id,
      }
    }
    if (id !== pluginId) {
      const depMarketplace = parsePluginIdentifier(id).marketplace
      const depSource = depMarketplace
        ? knownForPolicy[depMarketplace]?.source
        : undefined
      if (depSource && !isSourceAllowedByPolicy(depSource)) {
        return {
          ok: false,
          reason: 'dependency-marketplace-blocked-by-policy',
          pluginName: entry.name,
          blockedDependency: id,
          marketplaceName: depMarketplace!,
        }
      }
    }
  }

  // Load existing plugins before the settings write so xw7 can see
  // enabled dependents (rootRequiredByDependent) and version ranges.
  let loadedPlugins: LoadedPlugin[] = []
  try {
    const loaded = await loadAllPluginsCacheOnly()
    loadedPlugins = loaded.enabled.concat(loaded.disabled)
  } catch (error) {
    logForDebugging(
      `installResolvedPlugin: could not load existing plugins for version-range checks: ${toError(error).message}`,
      { level: 'warn' },
    )
  }

  const priorEnabled: Record<string, EnabledPluginSetting> = {
    ...getSettingsForSource(settingSource)?.enabledPlugins,
  }
  const { explicitAnywhere, enabledById } = collectExplicitEnabledPlugins()
  const rootRequiredByDependent = isRootRequiredByEnabledDependent(
    pluginId,
    loadedPlugins,
    enabledById,
  )

  function marketplaceEntryFor(id: string): PluginMarketplaceEntry | undefined {
    return id === pluginId ? entry : depInfo.get(id)?.entry
  }

  const defaultsById = new Map<string, boolean>()
  const dependenciesById = new Map<string, string[]>()
  for (const id of resolution.closure) {
    const marketplaceEntry = marketplaceEntryFor(id)
    defaultsById.set(id, marketplaceEntry?.defaultEnabled ?? true)
    dependenciesById.set(
      id,
      (marketplaceEntry?.dependencies ?? []).map(raw =>
        qualifyDependency(raw, id),
      ),
    )
  }

  // Official 2.1.154 `xw7`: honor defaultEnabled; do not force-true the closure.
  const solved = solveDefaultEnabled({
    closure: resolution.closure,
    rootId: pluginId,
    rootRequiredByDependent,
    priorEnabled,
    explicitAnywhere,
    defaultsById,
    dependenciesById,
  })
  const firstWrite = new Map<string, boolean | string[]>()
  const closureEnabled: Record<string, boolean | string[]> = {}
  for (const id of resolution.closure) {
    const prior = priorEnabled[id]
    const value = Array.isArray(prior) ? prior : (solved.get(id) ?? true)
    closureEnabled[id] = value
    firstWrite.set(id, value)
  }
  const { error } = updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...priorEnabled,
      ...closureEnabled,
    },
  })
  if (error) {
    return {
      ok: false,
      reason: 'settings-write-failed',
      message: error.message,
    }
  }

  // ── Materialize: cache each closure member ──
  const projectPath = scope !== 'user' ? getCwd() : undefined
  const closureIds = [...resolution.closure]
  let rootManifestDeps: string[] | undefined
  const manifestDefaults = new Map<string, boolean | undefined>()

  // Official 2.1.111 `wd1`: intersect version ranges from already-loaded
  // plugins (outside this closure) plus constraints discovered while
  // materializing. Distinguish conflicting / invalid / too-complex.
  const fromLoaded = new Map<string, string[]>()
  const fromClosure = new Map<string, string[]>()
  const closureSet = new Set(resolution.closure)
  const installedVersions = new Map<string, string | undefined>()
  for (const plugin of loadedPlugins) {
    installedVersions.set(
      plugin.source,
      plugin.resolvedVersion ?? plugin.manifest.version,
    )
    if (!plugin.depConstraints || closureSet.has(plugin.source)) continue
    for (const [raw, constraint] of Object.entries(plugin.depConstraints)) {
      if (constraint.version === undefined) continue
      const dep = qualifyDependency(raw, plugin.source)
      const list = fromLoaded.get(dep)
      if (list) list.push(constraint.version)
      else fromLoaded.set(dep, [constraint.version])
    }
  }

  async function materializeOne(
    id: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false
        reason: 'range-conflict'
        dep: string
        ranges: string[]
        why: VersionRequirementWhy
        installed?: string
      }
  > {
    let info = depInfo.get(id)
    // Root wasn't pre-seeded (caller didn't pass marketplaceInstallLocation
    // for a non-local source). Fetch now; it's needed for the cache write.
    if (!info && id === pluginId) {
      const mktLocation = (await getPluginById(id))?.marketplaceInstallLocation
      if (mktLocation) info = { entry, marketplaceInstallLocation: mktLocation }
    }
    if (!info) return { ok: true }

    const ranges = [
      ...(fromClosure.get(id) ?? []),
      ...(fromLoaded.get(id) ?? []),
    ]
    if (ranges.length > 0) {
      const intersected = intersectConstraints(ranges)
      if (intersected.ok === false) {
        return {
          ok: false,
          reason: 'range-conflict',
          dep: id,
          ranges,
          why: intersected.reason,
        }
      }
      // Official 111 then pins a git tag when range !== '*'. This tree
      // still lacks the 109/110 tag-lookup path; keep the existing cache.
    }

    let localSourcePath: string | undefined
    const { source } = info.entry
    if (isLocalPluginSource(source)) {
      localSourcePath = validatePathWithinBase(
        info.marketplaceInstallLocation,
        source,
      )
    }
    const cached = await cacheAndRegisterPlugin(
      id,
      info.entry,
      scope,
      projectPath,
      localSourcePath,
      id !== pluginId,
    )
    manifestDefaults.set(id, cached.defaultEnabled)
    if (id === pluginId) {
      rootManifestDeps = cached.dependencies
    }
    if (cached.depConstraints) {
      for (const [raw, constraint] of Object.entries(cached.depConstraints)) {
        if (constraint.version === undefined) continue
        const dep = qualifyDependency(raw, id)
        const list = fromClosure.get(dep)
        if (list) list.push(constraint.version)
        else fromClosure.set(dep, [constraint.version])
      }
    }
    return { ok: true }
  }

  // Official 2.1.111 materializes the closure back-to-front so already-
  // installed members can contribute constraints onto later members.
  for (let i = resolution.closure.length - 1; i >= 0; i--) {
    const id = resolution.closure[i]
    if (id === undefined) continue
    const materialized = await materializeOne(id)
    if (materialized.ok === false) return materialized
  }

  // Official 2.1.113: after materializing the new closure, fail install
  // when a newly discovered constraint conflicts with an already-installed
  // plugin that is not in this closure.
  for (const [dep, closureRanges] of fromClosure) {
    if (closureSet.has(dep) || !installedVersions.has(dep)) continue
    const ranges = closureRanges.concat(fromLoaded.get(dep) ?? [])
    const intersected = intersectConstraints(ranges)
    if (intersected.ok === false) {
      return {
        ok: false,
        reason: 'range-conflict',
        dep,
        ranges,
        why: intersected.reason,
      }
    }
    const installed = installedVersions.get(dep)
    if (
      intersected.range !== '*' &&
      !pluginVersionSatisfies(installed, intersected.range)
    ) {
      return {
        ok: false,
        reason: 'range-conflict',
        dep,
        ranges,
        why: 'installed-unsatisfied',
        installed,
      }
    }
  }

  // Official 2.1.110 `Y3z`: honor plugin.json dependencies the marketplace
  // entry omitted. Extra IDs are enabled + cached; names land in depNote.
  const extra = await collectExtraManifestDependencies({
    rootManifestDeps,
    pluginId,
    closureSet: new Set(closureIds),
    alreadyEnabled: getEnabledPluginIdsForScope(settingSource),
    rootMarketplace,
    allowedCrossMarketplaces,
    depInfo,
  })
  if (!extra.ok) {
    return {
      ok: false,
      reason: 'dependency-blocked-by-policy',
      pluginName: entry.name,
      blockedDependency: extra.blockedDependency,
    }
  }
  if (extra.ids.length > 0) {
    const extraEnabled: Record<string, true> = {}
    for (const id of extra.ids) {
      closureIds.push(id)
      extraEnabled[id] = true
      firstWrite.set(id, true)
    }
    const { error: extraError } = updateSettingsForSource(settingSource, {
      enabledPlugins: {
        ...getSettingsForSource(settingSource)?.enabledPlugins,
        ...extraEnabled,
      },
    })
    if (extraError) {
      return {
        ok: false,
        reason: 'settings-write-failed',
        message: extraError.message,
      }
    }
    for (const id of extra.ids) {
      const materialized = await materializeOne(id)
      if (materialized.ok === false) return materialized
    }
  }

  if (rootManifestDeps !== undefined) {
    const fromManifest = new Set(
      rootManifestDeps.map(d => qualifyDependency(d, pluginId)),
    )
    for (const raw of entry.dependencies ?? []) {
      const dep = qualifyDependency(raw, pluginId)
      if (!fromManifest.has(dep)) {
        logForDebugging(
          `Marketplace entry for ${pluginId} lists dependency "${dep}" not present in plugin.json — catalog may be stale`,
        )
      }
    }
  }

  // Official 2.1.154: re-run xw7 after extra plugin.json deps and apply
  // diffs. Extra ids were force-true'd above; defaultEnabled:false ones
  // that are not deps of an enabled member get corrected off.
  const correctionDefaults = new Map<string, boolean>()
  const correctionDeps = new Map<string, string[]>()
  for (const id of closureIds) {
    const marketplaceEntry = marketplaceEntryFor(id)
    correctionDefaults.set(
      id,
      marketplaceEntry?.defaultEnabled ?? manifestDefaults.get(id) ?? true,
    )
    const deps = (marketplaceEntry?.dependencies ?? []).map(raw =>
      qualifyDependency(raw, id),
    )
    if (id === pluginId) {
      for (const raw of rootManifestDeps ?? []) {
        deps.push(qualifyDependency(raw, pluginId))
      }
    }
    correctionDeps.set(id, deps)
  }
  const corrected = solveDefaultEnabled({
    closure: closureIds,
    rootId: pluginId,
    rootRequiredByDependent,
    priorEnabled,
    explicitAnywhere,
    defaultsById: correctionDefaults,
    dependenciesById: correctionDeps,
  })
  const correction: Record<string, boolean> = {}
  for (const id of closureIds) {
    const prior = priorEnabled[id]
    const next = corrected.get(id) ?? true
    if (prior !== undefined && prior !== next) continue
    if (firstWrite.get(id) !== next) correction[id] = next
  }
  if (Object.keys(correction).length > 0) {
    const { error: correctionError } = updateSettingsForSource(settingSource, {
      enabledPlugins: {
        ...getSettingsForSource(settingSource)?.enabledPlugins,
        ...correction,
      },
    })
    if (correctionError) {
      logForDebugging(
        `Failed to apply defaultEnabled correction for ${pluginId}: ${correctionError.message}`,
        { level: 'warn' },
      )
    }
  }

  clearAllCaches()

  const depNote = formatDependencyCountSuffix(
    closureIds.filter(id => id !== pluginId),
  )
  return { ok: true, closure: closureIds, depNote }
}

/**
 * Result of a plugin installation operation
 */
export type InstallPluginResult =
  | { success: true; message: string }
  | { success: false; error: string }

/**
 * Parameters for installing a plugin from marketplace
 */
export type InstallPluginParams = {
  pluginId: string
  entry: PluginMarketplaceEntry
  marketplaceName: string
  scope?: 'user' | 'project' | 'local'
  trigger?: 'hint' | 'user'
}

/**
 * Install a single plugin from a marketplace with the specified scope.
 * Interactive-UI wrapper around `installResolvedPlugin` — adds try/catch,
 * analytics, and UI-style message formatting.
 */
export async function installPluginFromMarketplace({
  pluginId,
  entry,
  marketplaceName,
  scope = 'user',
  trigger = 'user',
}: InstallPluginParams): Promise<InstallPluginResult> {
  try {
    // Look up the marketplace install location for local-source plugins.
    // Without this, plugins with relative-path sources fail from the
    // interactive UI path (/plugin install) even though the CLI path works.
    const pluginInfo = await getPluginById(pluginId)
    const marketplaceInstallLocation = pluginInfo?.marketplaceInstallLocation

    const result = await installResolvedPlugin({
      pluginId,
      entry,
      scope,
      marketplaceInstallLocation,
    })

    if (result.ok === false) {
      switch (result.reason) {
        case 'local-source-no-location':
          return {
            success: false,
            error: `Cannot install local plugin "${result.pluginName}" without marketplace install location`,
          }
        case 'settings-write-failed':
          return {
            success: false,
            error: `Failed to update settings: ${result.message}`,
          }
        case 'resolution-failed':
          return {
            success: false,
            error: formatResolutionError(result.resolution),
          }
        case 'blocked-by-policy':
          return {
            success: false,
            error: `Plugin "${result.pluginName}" is blocked by your organization's policy and cannot be installed`,
          }
        case 'dependency-blocked-by-policy':
          return {
            success: false,
            error: `Cannot install "${result.pluginName}": dependency "${result.blockedDependency}" is blocked by your organization's policy`,
          }
        case 'marketplace-blocked-by-policy':
          return {
            success: false,
            error: `Cannot install "${result.pluginName}": marketplace "${result.marketplaceName}" is blocked by your organization's policy`,
          }
        case 'dependency-marketplace-blocked-by-policy':
          return {
            success: false,
            error: `Cannot install "${result.pluginName}": dependency "${result.blockedDependency}" is from marketplace "${result.marketplaceName}", which is blocked by your organization's policy`,
          }
        case 'range-conflict':
          return {
            success: false,
            error: formatVersionRequirementError(
              result.dep === pluginId ? 'Plugin' : 'Dependency',
              result.dep,
              result.ranges,
              result.why,
              result.installed,
            ),
          }
        case 'no-matching-tag':
          return {
            success: false,
            error: formatNoMatchingTagError(
              result.dep === pluginId ? 'Plugin' : 'Dependency',
              result.dep,
              result.range,
            ),
          }
      }
    }

    // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns.
    // plugin_id kept in additional_metadata (redacted to 'third-party' for
    // non-official) because dbt external_claude_code_plugin_installs.sql
    // extracts $.plugin_id for official-marketplace install tracking. Other
    // plugin lifecycle events drop the blob key — no downstream consumers.
    logEvent('tengu_plugin_installed', {
      _PROTO_plugin_name:
        entry.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      _PROTO_marketplace_name:
        marketplaceName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      plugin_id: (isOfficialMarketplaceName(marketplaceName)
        ? pluginId
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      trigger:
        trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      install_source: (trigger === 'hint'
        ? 'ui-suggestion'
        : 'ui-discover') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(
        entry.name,
        marketplaceName,
        getManagedPluginNames(),
      ),
      ...(entry.version && {
        version:
          entry.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })

    return {
      success: true,
      message: `✓ Installed ${entry.name}${result.depNote}. Run /reload-plugins to activate.`,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logError(toError(err))
    return { success: false, error: `Failed to install: ${errorMessage}` }
  }
}

function projectPathForScope(scope: PluginScope): string | undefined {
  return scope === 'project' || scope === 'local' ? getOriginalCwd() : undefined
}

export async function scanOrphanedAutoDeps(
  scope: PluginScope,
): Promise<OrphanAutoScan> {
  const projectPath = projectPathForScope(scope)
  const { enabled, disabled } = await loadAllPlugins()
  return findOrphanedAutoDeps(
    loadInstalledPluginsV2().plugins,
    [...enabled, ...disabled],
    scope,
    projectPath,
  )
}

/**
 * Official 2.1.121 `aFK`. Remove auto-installed orphans at one scope.
 */
export async function pruneOrphanedAutoDeps(
  orphans: ReadonlySet<string>,
  scope: PluginScope,
  projectPath: string | undefined,
  { deleteDataDir = true }: { deleteDataDir?: boolean } = {},
): Promise<string[]> {
  if (orphans.size === 0) return []
  const installed = loadInstalledPluginsV2().plugins
  const lastScope: Array<{ id: string; installPath: string }> = []
  const removed: string[] = []
  for (const id of orphans) {
    const entries = installed[id]
    const entry = entries?.find(
      e => e.scope === scope && e.projectPath === projectPath,
    )
    if (!entry) continue
    removePluginInstallation(id, scope, projectPath)
    removed.push(id)
    if ((entries?.length ?? 0) <= 1) {
      lastScope.push({ id, installPath: entry.installPath })
    }
  }
  if (removed.length === 0) return []
  const settingSource = scopeToSettingSource(scope)
  const enabledPlugins: Record<string, boolean | string[] | undefined> = {
    ...getSettingsForSource(settingSource)?.enabledPlugins,
  }
  for (const id of removed) {
    enabledPlugins[id] = undefined
  }
  const { error } = updateSettingsForSource(settingSource, { enabledPlugins })
  if (error) {
    logForDebugging(
      `pruneOrphanedAutoDeps: settings write failed at ${scope}: ${error.message}`,
    )
  }
  clearAllCaches()
  for (const { id, installPath } of lastScope) {
    await markPluginVersionOrphaned(installPath)
    deletePluginOptions(id)
    if (deleteDataDir) await deletePluginDataDir(id)
  }
  return removed
}

export { formatOrphanPruneHint }
