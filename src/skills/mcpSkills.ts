import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import type { Command } from '../commands.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ConnectedMCPServer } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logMCPDebug, logMCPError } from '../utils/log.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import {
  parseUriTemplate,
  uriTemplateDisplayPrefix,
} from '../utils/mcpResourceTemplate.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_INDEX_URI = 'skill://index.json'
const MAX_SKILLS = 100
const CACHE_SIZE = 20
const MAX_SKILL_BYTES = 1_000_000

const SkillIndexSchema = z.object({
  $schema: z.string().optional(),
  skills: z.array(
    z.object({
      name: z.string().nullish(),
      type: z.string().nullish(),
      description: z.string().nullish(),
      url: z.string().nullish(),
    }),
  ),
})

type Meta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

function featureOk(name: string): void {
  logEvent('tengu_feature_ok', { feature_name: name as Meta })
}

function featureBad(name: string, code: string): void {
  logEvent('tengu_feature_bad', {
    feature_name: name as Meta,
    error_code: code as Meta,
  })
}

function featureSad(name: string, code: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: name as Meta,
    error_code: code as Meta,
  })
}

function mcpTimeoutMs(): number {
  const parsed = parseInt(process.env.MCP_TIMEOUT || '', 10)
  return parsed > 0 ? parsed : 30_000
}

/** Official 161 `Wk`. */
export function isMcpSkillsEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_mcp_skills', false)
}

function templateArgNames(uriTemplate: string): string[] {
  return parseUriTemplate(uriTemplate)
    .filter((part): part is { type: 'variable'; name: string } => part.type === 'variable')
    .map(part => part.name)
}

function templateArgumentHint(uriTemplate: string): string {
  const parts = parseUriTemplate(uriTemplate)
  const first = parts.findIndex(part => part.type === 'variable')
  if (first === -1) return ''
  let last = first
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.type === 'variable') {
      last = i
      break
    }
  }
  return parts
    .slice(first, last + 1)
    .map(part => (part.type === 'variable' ? `<${part.name}>` : part.value))
    .join('')
}

function templateSuffix(uriTemplate: string): string {
  const i = uriTemplate.lastIndexOf('}')
  return i === -1 ? '' : uriTemplate.slice(i + 1)
}

function instantiateTemplate(uriTemplate: string, args: string): string {
  const trimmed = args.trim()
  if (trimmed.includes('://')) return trimmed
  return uriTemplateDisplayPrefix(uriTemplate) + trimmed + templateSuffix(uriTemplate)
}

/** Official 161 `_I6`. */
function uriMatchesTemplate(uri: string, uriTemplate: string): boolean {
  const parts = parseUriTemplate(uriTemplate)
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === 'literal') {
      if (!uri.startsWith(part.value, cursor)) return false
      cursor += part.value.length
      continue
    }
    let next = i + 1
    while (parts[next]?.type === 'variable') next++
    const lit = parts[next]
    if (lit?.type === 'literal') {
      const at =
        next === parts.length - 1
          ? uri.lastIndexOf(lit.value)
          : uri.indexOf(lit.value, cursor)
      if (at <= cursor) return false
      cursor = at
      i = next - 1
    } else {
      return uri.length > cursor
    }
  }
  return cursor === uri.length
}

async function readResourceText(
  client: ConnectedMCPServer,
  uri: string,
): Promise<string | undefined> {
  const result = await client.client.request(
    { method: 'resources/read', params: { uri } },
    ReadResourceResultSchema,
    { timeout: mcpTimeoutMs() },
  )
  const block = result.contents?.find(
    item => 'text' in item && typeof item.text === 'string',
  )
  if (!block || !('text' in block) || typeof block.text !== 'string') {
    return undefined
  }
  return block.text
}

async function discoverSkillIndex(client: ConnectedMCPServer): Promise<{
  concrete: Array<{ name: string; url: string; description?: string | null }>
  templates: Array<{ name: string; url: string; description: string }>
}> {
  const empty = { concrete: [], templates: [] }
  let raw: string
  try {
    const text = await readResourceText(client, SKILL_INDEX_URI)
    if (!text) return empty
    raw = text
    if (raw.length > MAX_SKILL_BYTES) {
      logMCPDebug(
        client.name,
        `${SKILL_INDEX_URI} exceeds ${MAX_SKILL_BYTES / 1e6}MB, skipping skill discovery`,
      )
      featureSad('skill_mcp_load', 'skill_mcp_index_too_large')
      return empty
    }
  } catch {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logMCPDebug(
      client.name,
      `${SKILL_INDEX_URI} is not valid JSON (${errorMessage(err)}) — skipping skill discovery`,
    )
    featureSad('skill_mcp_load', 'skill_mcp_index_invalid_json')
    return empty
  }
  const checked = SkillIndexSchema.safeParse(parsed)
  if (!checked.success) {
    logMCPDebug(
      client.name,
      `${SKILL_INDEX_URI} does not match the discovery schema — skipping skill discovery`,
    )
    featureSad('skill_mcp_load', 'skill_mcp_index_schema_invalid')
    return empty
  }
  const concrete = checked.data.skills
    .filter(s => s.type === 'skill-md' && !!s.name && !!s.url)
    .slice(0, MAX_SKILLS)
    .map(s => ({ name: s.name!, url: s.url!, description: s.description }))
  const templates = checked.data.skills
    .flatMap(s =>
      s.type === 'mcp-resource-template' && s.name && s.url
        ? [{ name: s.name, url: s.url, description: s.description ?? '' }]
        : [],
    )
    .slice(0, MAX_SKILLS)
  return { concrete, templates }
}

async function loadConcreteSkill(
  client: ConnectedMCPServer,
  uri: string,
  skillName: string,
  builders: ReturnType<typeof getMCPSkillBuilders>,
  onError: (code: string) => void,
): Promise<Command | null> {
  try {
    const text = await readResourceText(client, uri)
    if (!text) {
      logMCPDebug(client.name, `Skill resource ${uri} has no text content`)
      onError('skill_mcp_no_text_content')
      return null
    }
    if (text.length > MAX_SKILL_BYTES) {
      logMCPDebug(
        client.name,
        `Skill resource ${uri} exceeds ${MAX_SKILL_BYTES / 1e6}MB, skipping`,
      )
      onError('skill_mcp_content_too_large')
      return null
    }
    const { frontmatter, content } = parseFrontmatter(text, uri)
    const fields = builders.parseSkillFrontmatterFields(
      frontmatter,
      content,
      skillName,
    )
    const safeName = normalizeNameForMCP(skillName)
    if (fields.hooks) {
      logMCPDebug(
        client.name,
        `Skill '${safeName}' declared hooks in frontmatter — ignored (MCP-sourced skills cannot register hooks)`,
      )
    }
    if (fields.allowedTools.length > 0) {
      logMCPDebug(
        client.name,
        `Skill '${safeName}' declared allowed-tools in frontmatter — ignored (MCP-sourced skills cannot bypass permissions)`,
      )
    }
    const qualified = `${normalizeNameForMCP(client.name)}:${safeName}`
    logMCPDebug(client.name, `Loaded MCP skill '${safeName}' from ${uri}`)
    return builders.createSkillCommand({
      ...fields,
      hooks: undefined,
      allowedTools: [],
      executionContext: undefined,
      agent: undefined,
      model: undefined,
      effort: undefined,
      shell: undefined,
      skillName: qualified,
      markdownContent: content,
      source: 'mcp',
      baseDir: undefined,
      loadedFrom: 'mcp',
      paths: undefined,
    })
  } catch (err) {
    logMCPError(
      client.name,
      `Failed to load MCP skill from ${uri}: ${errorMessage(err)}`,
    )
    onError('skill_mcp_fetch_failed')
    return null
  }
}

function loadTemplateSkill(
  client: ConnectedMCPServer,
  skill: { name: string; url: string; description: string },
  builders: ReturnType<typeof getMCPSkillBuilders>,
): Command {
  const serverName = normalizeNameForMCP(client.name)
  const skillName = normalizeNameForMCP(skill.name)
  const qualified = `${serverName}:${skillName}`
  const hint = templateArgumentHint(skill.url)
  const argNames = templateArgNames(skill.url)
  return {
    type: 'prompt',
    name: qualified,
    description: skill.description,
    argumentHint: hint || undefined,
    argNames: argNames.length > 0 ? argNames : undefined,
    isMcp: true,
    isHidden: false,
    userInvocable: true,
    loadedFrom: 'mcp',
    source: 'mcp',
    urlTemplate: skill.url,
    contentLength: 0,
    progressMessage: `Loading skill from ${serverName}`,
    allowedTools: [],
    userFacingName: () => `${serverName}:${uriTemplateDisplayPrefix(skill.url)}`,
    async getPromptForCommand(args, context) {
      const uri = instantiateTemplate(skill.url, args)
      if (!uriMatchesTemplate(uri, skill.url)) {
        featureBad('skill_mcp_load', 'skill_mcp_template_uri_invalid')
        return [
          {
            type: 'text' as const,
            text: `Error: '${uri}' is not a valid instance of skill template ${skill.url}. Provide args matching '${hint}' or a full URI.`,
          },
        ]
      }
      const connected = (await builders.ensureConnectedClient(
        client,
      )) as ConnectedMCPServer
      let loadError: string | null = null
      const loaded = await loadConcreteSkill(
        connected,
        uri,
        skill.name,
        builders,
        code => {
          loadError = code
        },
      )
      if (!loaded || loaded.type !== 'prompt') {
        featureBad(
          'skill_mcp_load',
          loadError ?? 'skill_mcp_template_load_failed',
        )
        return [
          {
            type: 'text' as const,
            text: `Error: failed to load skill from ${uri} on MCP server '${client.name}'.`,
          },
        ]
      }
      return loaded.getPromptForCommand('', context)
    },
  }
}

/**
 * Official 161 `I$A` / `C$A` / `GT4` / `b$A`.
 */
export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: ConnectedMCPServer): Promise<Command[]> => {
    if (!client.capabilities?.resources) return []
    const { concrete, templates } = await discoverSkillIndex(client)
    if (concrete.length === 0 && templates.length === 0) return []
    logMCPDebug(
      client.name,
      `Found ${concrete.length} skill(s) and ${templates.length} skill template(s) in ${SKILL_INDEX_URI}`,
    )
    const builders = getMCPSkillBuilders()
    let firstError: string | null = null
    const onError = (code: string): void => {
      firstError = code
    }
    const loaded = await Promise.all(
      concrete.map(skill =>
        loadConcreteSkill(client, skill.url, skill.name, builders, onError),
      ),
    )
    const templated = templates.map(skill =>
      loadTemplateSkill(client, skill, builders),
    )
    const skills = [
      ...loaded.filter((s): s is Command => s !== null),
      ...templated,
    ]
    if (firstError) featureBad('skill_mcp_load', firstError)
    else if (skills.length > 0) featureOk('skill_mcp_load')
    if (skills.length > 0) {
      logForDebugging(
        `[mcp-skills] Loaded ${skills.length} skills from MCP server '${client.name}'`,
      )
    }
    return skills
  },
  client => client.name,
  CACHE_SIZE,
)
