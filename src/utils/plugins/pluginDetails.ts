/**
 * Official 2.1.139 `G14` — `/plugin details <name>` support.
 *
 * Builds a plugin's component inventory (skills / agents / commands / hooks /
 * MCP servers) and its projected token cost. Ported from the 139 bundle:
 *
 *   sR6 -> getPluginInventory
 *   u35 -> computePluginTokenCost
 *   m35 -> scaleCharsToTokens
 *   AJH -> formatTokenEstimate
 *
 * Only 139-tree symbols are imported.
 */
import { readFile, readdir, open, stat } from 'fs/promises'
import { basename, join } from 'path'
import type {
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getBuiltinPluginDefinition } from '../../plugins/builtinPlugins.js'
import { countMessagesTokensWithAPI } from '../../services/tokenEstimation.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { formatTokens } from '../format.js'
import { parseFrontmatter } from '../frontmatterParser.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, toError } from '../errors.js'
import { logError } from '../log.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { getMarketplace } from './marketplaceManager.js'
import type { PluginMarketplaceEntry } from './schemas.js'

const BUILTIN_SOURCE = 'builtin'
const INLINE_SOURCE = 'inline'
/** Cap on how much of a component file we read for token projection. */
const COMPONENT_READ_LIMIT = 1048576

/** A single counted component (skill / agent / command) in an inventory. */
export type InventoryComponent = {
  name: string
  path?: string
  /** Character counts, present once computePluginTokenCost has run. */
  chars?: { always_on: number; on_invoke: number }
}

/** The full component inventory for a plugin. */
export type PluginInventory = {
  commands: InventoryComponent[]
  agents: InventoryComponent[]
  skills: InventoryComponent[]
  hooks: string[]
  mcpServers: string[]
}

/** Projected token cost for one model: always-on (every session) + on-invoke. */
export type ModelTokenCost = { always_on: number; on_invoke: number }

/** Result of computePluginTokenCost. */
export type PluginTokenCost = {
  tokens: Record<string, ModelTokenCost>
  inventory: PluginInventory
}

/** Raw per-component text split into always-on vs on-invoke. */
type ComponentParts = { alwaysOn: string; onInvoke: string }

/**
 * m35: scale a component's character count into a token estimate.
 * When an API token count is available for the full text, scale proportionally;
 * otherwise fall back to a ~4 chars/token rough estimate.
 */
export function scaleCharsToTokens(
  charCount: number,
  totalChars: number,
  apiTokens: number | undefined,
  bytesPerToken: number = 4,
): number {
  if (apiTokens !== undefined && totalChars > 0) {
    return Math.round((charCount / totalChars) * apiTokens)
  }
  return Math.round(charCount / bytesPerToken)
}

/**
 * AJH: human-readable token estimate. Values under 20 are shown as a floor
 * ("< 20"); larger values round to the nearest 10 and get a "~" prefix.
 */
export function formatTokenEstimate(tokens: number): string {
  if (tokens < 20) return '< 20'
  return `~${formatTokens(Math.round(tokens / 10) * 10)}`
}

/**
 * sR6: build the component inventory for a loaded plugin.
 * `sourceKind` is the plugin source suffix: `builtin`, `inline`, or a
 * marketplace name.
 */
export async function getPluginInventory(
  plugin: LoadedPlugin,
  sourceKind: string,
): Promise<PluginInventory> {
  if (sourceKind === BUILTIN_SOURCE) {
    const definition = getBuiltinPluginDefinition(plugin.name)
    if (!definition) throw new Error(`Built-in plugin ${plugin.name} not found`)
    return {
      commands: [],
      agents: [],
      skills: definition.skills?.map(skill => ({ name: skill.name })) ?? [],
      hooks: definition.hooks ? Object.keys(definition.hooks) : [],
      mcpServers: definition.mcpServers
        ? Object.keys(definition.mcpServers)
        : [],
    }
  }

  const isInline = sourceKind === INLINE_SOURCE
  const entryName = parsePluginIdentifier(plugin.source).name || plugin.name
  // Marketplace entry (only for marketplace-installed plugins), used as a
  // fallback source of hook/MCP-server names when the plugin manifest omits them.
  const marketplaceEntry: PluginMarketplaceEntry | undefined = isInline
    ? undefined
    : (await getMarketplace(sourceKind)).plugins.find(e => e.name === entryName)
  if (!marketplaceEntry && !isInline) {
    throw new Error(`Plugin ${entryName} not found in marketplace ${sourceKind}`)
  }

  const [commands, agents, skills] = await Promise.all([
    loadMarkdownFileNames([
      plugin.commandsPath,
      ...(plugin.commandsPaths ?? []),
    ]),
    loadMarkdownFileNames([
      plugin.agentsPath,
      ...(plugin.agentsPaths ?? []),
    ]),
    loadSkillDirNames([
      plugin.skillsPath,
      ...(plugin.skillsPaths ?? []),
    ]),
  ])

  const hooks = plugin.hooksConfig
    ? Object.keys(plugin.hooksConfig)
    : collectConfigKeys(marketplaceEntry?.hooks)
  const mcpServers = plugin.mcpServers
    ? Object.keys(plugin.mcpServers)
    : collectConfigKeys(marketplaceEntry?.mcpServers)

  return { commands, agents, skills, hooks, mcpServers }
}

/**
 * u35: compute the projected token cost of an inventory for a set of models.
 * Counts the concatenated always-on text and on-invoke text once per model,
 * and attaches per-component character counts to the returned inventory.
 */
export async function computePluginTokenCost(
  inventory: PluginInventory,
  models: string[],
  pluginName: string,
): Promise<PluginTokenCost> {
  const [skillParts, agentParts, commandParts] = await Promise.all([
    Promise.all(
      inventory.skills.map(skill =>
        readComponentParts(
          skill.path ? join(skill.path, 'SKILL.md') : undefined,
          qualifiedName(skill.name, pluginName),
        ),
      ),
    ),
    Promise.all(
      inventory.agents.map(agent =>
        readComponentParts(agent.path, agent.name),
      ),
    ),
    Promise.all(
      inventory.commands.map(command =>
        readComponentParts(
          command.path,
          qualifiedName(command.name, pluginName),
        ),
      ),
    ),
  ])

  const allParts = [...skillParts, ...agentParts, ...commandParts]
  const alwaysOnText = allParts
    .map(part => part.alwaysOn)
    .filter(Boolean)
    .join('\n')
  const onInvokeText = allParts
    .map(part => part.onInvoke)
    .filter(Boolean)
    .join('\n\n')

  const tokens: Record<string, ModelTokenCost> = {}
  for (const model of models) {
    const [alwaysOnTokens, onInvokeTokens] = await Promise.all([
      countTextTokens(alwaysOnText),
      countTextTokens(onInvokeText),
    ])
    if (alwaysOnTokens !== null && onInvokeTokens !== null) {
      tokens[model] = {
        always_on: alwaysOnTokens,
        on_invoke: onInvokeTokens,
      }
    }
  }

  return {
    tokens,
    inventory: {
      ...inventory,
      skills: withChars(inventory.skills, skillParts),
      agents: withChars(inventory.agents, agentParts),
      commands: withChars(inventory.commands, commandParts),
    },
  }
}

/** L14: `plugin:skill`-style qualified display name for skills/commands. */
function qualifiedName(name: string, pluginName?: string): string {
  if (!pluginName) return name
  return `${pluginName}:${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

/** jE6: the always-on context line for a component (name/desc/whenToUse). */
function contextLine(component: {
  name: string
  description?: string | null
  whenToUse?: string
}): string {
  return [component.name, component.description, component.whenToUse]
    .filter(Boolean)
    .join(' ')
}

/**
 * oR6: read a component file and split it into always-on vs on-invoke text.
 * Returns empty parts (not a throw) when the file is missing or unreadable.
 */
async function readComponentParts(
  filePath: string | undefined,
  displayName: string,
): Promise<ComponentParts> {
  if (!filePath) return { alwaysOn: '', onInvoke: '' }

  let raw: string
  try {
    raw = await readFileHead(filePath, COMPONENT_READ_LIMIT)
  } catch (error) {
    logComponentReadError(filePath, error)
    return { alwaysOn: '', onInvoke: '' }
  }

  const { frontmatter, content } = parseFrontmatter(raw, filePath)
  const description =
    normalizeDescription(frontmatter.description, displayName) ??
    firstHeading(content, 'Skill')
  const whenToUse =
    frontmatter.when_to_use != null ? String(frontmatter.when_to_use) : undefined

  return {
    alwaysOn: contextLine({ name: displayName, description, whenToUse }),
    onInvoke: content.trim(),
  }
}

/** dh: coerce a frontmatter description to a trimmed string or null. */
function normalizeDescription(
  description: unknown,
  displayName: string,
): string | null {
  if (description == null) return null
  if (typeof description === 'string') return description.trim() || null
  if (typeof description === 'number' || typeof description === 'boolean') {
    return String(description)
  }
  logForDebugging(
    `Description invalid for ${displayName} - omitting`,
    { level: 'warn' },
  )
  return null
}

/** ge: fall back to the first markdown heading, or a default label. */
function firstHeading(content: string, fallback = 'Custom item'): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const heading = trimmed.match(/^#+\s+(.+)$/)?.[1] ?? trimmed
    return heading.length > 100 ? heading.substring(0, 97) + '...' : heading
  }
  return fallback
}

/** aR6: attach per-component character counts to the inventory entries. */
function withChars(
  components: InventoryComponent[],
  parts: ComponentParts[],
): InventoryComponent[] {
  return components.map((component, index) => {
    const part = parts[index]
    if (!part) return component
    return {
      ...component,
      chars: {
        always_on: part.alwaysOn.length,
        on_invoke: part.onInvoke.length,
      },
    }
  })
}

/** P14: count the tokens of a text blob (0 for empty, null on API failure). */
async function countTextTokens(text: string): Promise<number | null> {
  if (!text) return 0
  const message: MessageParam = { role: 'user', content: text }
  return countMessagesTokensWithAPI([message], [])
}

/**
 * W14: flatten a hook/MCP config into its keys. The marketplace-entry hooks /
 * mcpServers fields are a union (path string | record | array of those); only
 * object entries contribute keys (a path string is filtered out, matching the
 * bundle's `[H].flat().filter(typeof==="object").flatMap(Object.keys)`).
 */
function collectConfigKeys(
  config: unknown,
): string[] {
  return ([config] as unknown[])
    .flat()
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry != null && typeof entry === 'object',
    )
    .flatMap(Object.keys)
}

/** p35: read up to `maxBytes` from a file as utf-8 text. */
async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const toRead = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(toRead)
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Z14: list `.md` files in a set of directories as {name, path} entries.
 * A missing directory is logged and skipped (not fatal).
 */
async function loadMarkdownFileNames(
  directories: (string | undefined)[],
): Promise<InventoryComponent[]> {
  const results: InventoryComponent[] = []
  for (const dir of directories) {
    if (!dir) continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      logComponentReadError(dir, error)
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({
          name: basename(entry.name, '.md'),
          path: join(dir, entry.name),
        })
      }
    }
  }
  return results
}

/**
 * $35: list skill directories (subdirs containing a SKILL.md) as {name, path}.
 * A missing directory is logged and skipped (not fatal).
 */
async function loadSkillDirNames(
  directories: (string | undefined)[],
): Promise<InventoryComponent[]> {
  const results: InventoryComponent[] = []
  for (const dir of directories) {
    if (!dir) continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      logComponentReadError(dir, error)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillDir = join(dir, entry.name)
      try {
        if ((await stat(join(skillDir, 'SKILL.md'))).isFile()) {
          results.push({ name: entry.name, path: skillDir })
        }
      } catch {
        // No SKILL.md — not a skill dir.
      }
    }
  }
  return results
}

/** tR6: log a component-read failure without aborting the inventory build. */
function logComponentReadError(location: string, error: unknown): void {
  logForDebugging(
    `Failed to read plugin components from ${location}: ${errorMessage(error)}`,
    { level: 'error' },
  )
  logError(toError(error))
}
