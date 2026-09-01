/**
 * Official 2.1.118 `d68` / `Q68` / `wz$`: plan and create a
 * {name}--v{version} git tag for a plugin, with version validation.
 */
import { readFile, stat } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { valid } from 'semver'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { errorMessage, isENOENT } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { findGitRoot, gitExe } from '../git.js'
import { jsonParse } from '../slowOperations.js'
import type { ValidationResult } from './validatePlugin.js'
import { validateManifest, validatePluginContents } from './validatePlugin.js'
import { PluginMarketplaceSchema } from './schemas.js'

const TAG_VERSION_SEP = '--v'

export const PLUGIN_TAG_USAGE = `Usage: /plugin tag [path] [--push] [--dry-run] [-f|--force]

Create a {name}--v{version} git tag for the plugin at <path> (default: .).
Validates plugin.json and any enclosing marketplace entry agree on the version.

For -m/--message and --remote, use the CLI: claude plugin tag --help`

export type PluginTagPlan = {
  pluginName: string
  version: string
  versionFrom: 'plugin.json' | 'marketplace entry'
  tag: string
  pluginRoot: string
  gitRoot: string
  marketplace?: {
    path: string
    entryIndex: number
    entryVersion?: string
  }
}

export type PluginTagPlanResult =
  | { ok: true; warnings: string[]; plan: PluginTagPlan }
  | { ok: false; error: string; warnings: string[] }

export type PluginTagCreateResult =
  | { ok: true; pushed: boolean }
  | { ok: false; error: string }

export function formatPluginTagName(name: string, version: string): string {
  return `${name}${TAG_VERSION_SEP}${version}`
}

export function isValidGitRef(ref: string): boolean {
  if (!ref || ref.startsWith('-') || ref.startsWith('/')) return false
  if (ref.includes('..')) return false
  if (ref.split('/').some(part => part === '.' || part === '')) return false
  if (!/^[a-zA-Z0-9/._+@-]+$/.test(ref)) return false
  return true
}

export function formatTagMessage(
  plan: Pick<PluginTagPlan, 'pluginName' | 'version'>,
  message: string | undefined,
): string {
  return message === undefined
    ? `${plan.pluginName} ${plan.version}`
    : message.replaceAll('%s', plan.version)
}

function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = resolve(p)
    return resolved.endsWith(sep) ? resolved.slice(0, -sep.length) : resolved
  }
  return norm(a) === norm(b)
}

async function readMarketplaceJson(path: string) {
  let raw: string
  try {
    raw = await readFile(path, { encoding: 'utf-8' })
  } catch (err) {
    if (isENOENT(err)) return undefined
    return undefined
  }
  let parsed: unknown
  try {
    parsed = jsonParse(raw)
  } catch {
    return undefined
  }
  const result = PluginMarketplaceSchema().safeParse(parsed)
  return result.success ? result.data : undefined
}

function marketplaceEntryMatches(
  entry: { name?: string; source?: unknown },
  marketplaceDir: string,
  pluginRoot: string,
  pluginName: string,
): boolean {
  if (typeof entry.source === 'string') {
    return pathsEqual(resolve(marketplaceDir, entry.source), pluginRoot)
  }
  return entry.name === pluginName
}

async function findEnclosingMarketplace(
  pluginRoot: string,
  pluginName: string,
): Promise<
  | { path: string; entryIndex: number; entry: { name?: string; version?: string; source?: unknown } }
  | undefined
> {
  const gitRoot = findGitRoot(pluginRoot) ?? undefined
  let dir = pluginRoot
  for (;;) {
    const marketplacePath = join(dir, '.claude-plugin', 'marketplace.json')
    const marketplace = await readMarketplaceJson(marketplacePath)
    if (marketplace) {
      for (const [entryIndex, entry] of marketplace.plugins.entries()) {
        if (marketplaceEntryMatches(entry, dir, pluginRoot, pluginName)) {
          return { path: marketplacePath, entryIndex, entry }
        }
      }
    }
    if (dir === gitRoot) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function resolvePluginManifest(inputPath: string): Promise<
  | { ok: true; pluginRoot: string; manifestPath: string; manifest: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const resolved = resolve(inputPath)
  let stats
  try {
    stats = await stat(resolved)
  } catch (err) {
    return {
      ok: false,
      error: isENOENT(err)
        ? `Path not found: ${resolved}`
        : `Cannot stat ${resolved}: ${errorMessage(err)}`,
    }
  }
  const candidates: Array<[string, string]> = stats.isFile()
    ? [[dirname(dirname(resolved)), resolved]]
    : [
        [resolved, join(resolved, '.claude-plugin', 'plugin.json')],
        [dirname(resolved), join(resolved, 'plugin.json')],
      ]
  for (const [pluginRoot, manifestPath] of candidates) {
    let raw: string
    try {
      raw = await readFile(manifestPath, { encoding: 'utf-8' })
    } catch (err) {
      if (isENOENT(err)) continue
      return { ok: false, error: `Cannot read ${manifestPath}: ${errorMessage(err)}` }
    }
    let parsed: unknown
    try {
      parsed = jsonParse(raw)
    } catch (err) {
      return { ok: false, error: `Invalid JSON in ${manifestPath}: ${errorMessage(err)}` }
    }
    return {
      ok: true,
      pluginRoot,
      manifestPath,
      manifest:
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {},
    }
  }
  return {
    ok: false,
    error: `No plugin manifest found. Expected ${join(resolved, '.claude-plugin', 'plugin.json')}.`,
  }
}

async function dirtyPaths(
  gitRoot: string,
  paths: string[],
): Promise<string[]> {
  const rels = paths.map(p => relative(gitRoot, p) || '.')
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['status', '--porcelain', '--', ...rels],
    { cwd: gitRoot },
  )
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .map(line => line.slice(3).trim())
    .filter(line => line.length > 0)
}

async function localTagExists(gitRoot: string, tag: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['tag', '-l', '--', tag],
    { cwd: gitRoot },
  )
  return result.code === 0 && result.stdout.trim() === tag
}

export async function planPluginTag(
  inputPath: string,
  options: { force?: boolean } = {},
): Promise<PluginTagPlanResult> {
  const warnings: string[] = []
  const resolved = await resolvePluginManifest(inputPath)
  if ('error' in resolved) {
    return { ok: false, error: resolved.error, warnings }
  }
  const { pluginRoot, manifestPath, manifest } = resolved

  const pluginValidation = await validateManifest(manifestPath)
  const validations: ValidationResult[] = [pluginValidation]
  if (pluginValidation.success) {
    validations.push(...(await validatePluginContents(pluginRoot)))
  }
  for (const result of validations) {
    for (const warning of result.warnings) {
      warnings.push(
        `${relative(getOriginalCwd(), result.filePath)}: ${warning.message}`,
      )
    }
  }
  const failed = validations.find(result => !result.success)
  if (failed) {
    const details = failed.errors
      .map(e => `  ${e.path}: ${e.message}`)
      .join('\n')
    return {
      ok: false,
      error: `Plugin validation failed for ${failed.filePath}:\n${details}`,
      warnings,
    }
  }

  const pluginName = manifest.name
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    return {
      ok: false,
      error: `plugin.json at ${manifestPath} has no "name" field`,
      warnings,
    }
  }

  const marketplace = await findEnclosingMarketplace(pluginRoot, pluginName)
  const manifestVersion =
    typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : undefined
  let version: string
  let versionFrom: PluginTagPlan['versionFrom']
  if (manifestVersion !== undefined) {
    version = manifestVersion
    versionFrom = 'plugin.json'
  } else if (marketplace?.entry.version) {
    version = marketplace.entry.version
    versionFrom = 'marketplace entry'
  } else {
    return {
      ok: false,
      error:
        `No version to tag. Set "version" in ${relative(getOriginalCwd(), manifestPath)}` +
        (marketplace
          ? ` or in the marketplace entry at ${relative(getOriginalCwd(), marketplace.path)} plugins[${marketplace.entryIndex}].`
          : '.') +
        ' Tags are only used for dependency version constraints, which require an explicit semver — the git-SHA fallback does not need a tag.',
      warnings,
    }
  }

  if (
    marketplace?.entry.version &&
    manifestVersion !== undefined &&
    marketplace.entry.version !== manifestVersion
  ) {
    return {
      ok: false,
      error: `Version mismatch: plugin.json says "${manifestVersion}" but ${relative(getOriginalCwd(), marketplace.path)} plugins[${marketplace.entryIndex}].version says "${marketplace.entry.version}". plugin.json wins at install time, so update the marketplace entry to "${manifestVersion}" (or remove it) before tagging.`,
      warnings,
    }
  }

  if (valid(version) === null) {
    return {
      ok: false,
      error: `Version "${version}" is not valid semver. Dependency resolution (resolveVersionRange) ignores tags whose suffix doesn't parse as semver, so this tag would never be selected.`,
      warnings,
    }
  }

  const tag = formatPluginTagName(pluginName, version)
  if (!isValidGitRef(tag)) {
    return {
      ok: false,
      error: `Computed tag name "${tag}" is not a valid git ref. Check the plugin name for characters git rejects (spaces, ~, ^, :, ?, *, [, \\, or sequences like .., @{, //).`,
      warnings,
    }
  }

  const gitRoot = findGitRoot(pluginRoot)
  if (gitRoot === null) {
    return {
      ok: false,
      error: `${pluginRoot} is not inside a git repository. Dependency tags are resolved via git ls-remote, so the plugin must live in a git repo.`,
      warnings,
    }
  }

  if (!options.force) {
    const dirty = await dirtyPaths(
      gitRoot,
      marketplace ? [pluginRoot, marketplace.path] : [pluginRoot],
    )
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 5).join('\n  ')
      const more =
        dirty.length > 5 ? `\n  …and ${dirty.length - 5} more` : ''
      return {
        ok: false,
        error: `Uncommitted changes affecting this release — commit them first so the tag points at the version you intend to release (or use --force):\n  ${shown}${more}`,
        warnings,
      }
    }
    if (await localTagExists(gitRoot, tag)) {
      return {
        ok: false,
        error: `Tag "${tag}" already exists locally. Bump the version in ${versionFrom}, or re-run with --force to move the tag.`,
        warnings,
      }
    }
  }

  return {
    ok: true,
    warnings,
    plan: {
      pluginName,
      version,
      versionFrom,
      tag,
      pluginRoot,
      gitRoot,
      marketplace: marketplace
        ? {
            path: marketplace.path,
            entryIndex: marketplace.entryIndex,
            entryVersion: marketplace.entry.version,
          }
        : undefined,
    },
  }
}

export async function createPluginTag(
  plan: PluginTagPlan,
  options: {
    push?: boolean
    force?: boolean
    message?: string
    remote: string
  },
): Promise<PluginTagCreateResult> {
  const tagArgs = ['tag']
  if (options.force) tagArgs.push('-f')
  tagArgs.push('-a', plan.tag, '-m', formatTagMessage(plan, options.message), 'HEAD')
  const tagged = await execFileNoThrowWithCwd(gitExe(), tagArgs, {
    cwd: plan.gitRoot,
  })
  if (tagged.code !== 0) {
    return {
      ok: false,
      error: `git tag failed (exit ${tagged.code}): ${tagged.stderr.trim() || tagged.stdout.trim()}`,
    }
  }
  if (!options.push) {
    return { ok: true, pushed: false }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.remote)) {
    return {
      ok: false,
      error: `Tag created locally but not pushed: "${options.remote}" is not a valid remote name.`,
    }
  }
  const pushArgs = ['push']
  if (options.force) pushArgs.push('--force')
  pushArgs.push(options.remote, `refs/tags/${plan.tag}`)
  const pushed = await execFileNoThrowWithCwd(gitExe(), pushArgs, {
    cwd: plan.gitRoot,
  })
  if (pushed.code !== 0) {
    return {
      ok: false,
      error: `Tag created locally but push failed (exit ${pushed.code}): ${pushed.stderr.trim() || pushed.stdout.trim()}`,
    }
  }
  return { ok: true, pushed: true }
}

export function formatPluginTagDryRun(
  plan: PluginTagPlan,
  options: { force?: boolean; remote?: string; message?: string },
): string[] {
  const remote = options.remote ?? 'origin'
  const force = options.force ?? false
  const annotation = formatTagMessage(plan, options.message)
  const push = `git -C ${plan.gitRoot} push ${force ? '--force ' : ''}${remote} refs/tags/${plan.tag}`
  return [
    `Dry run — would create tag ${plan.tag} at HEAD in ${plan.gitRoot}`,
    `  git -C ${plan.gitRoot} tag ${force ? '-f ' : ''}-a ${plan.tag} -m ${quote([annotation])}`,
    `  ${push}`,
  ]
}
