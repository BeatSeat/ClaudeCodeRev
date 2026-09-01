import Fuse from 'fuse.js'
import { basename } from 'path'
import type { SuggestionItem } from 'src/components/PromptInput/PromptInputFooterSuggestions.js'
import { generateFileSuggestions } from 'src/hooks/fileSuggestions.js'
import { completeResourceTemplate } from 'src/services/mcp/client.js'
import type {
  MCPServerConnection,
  ServerResource,
  ServerResourceTemplate,
} from 'src/services/mcp/types.js'
import { getAgentColor } from 'src/tools/AgentTool/agentColorManager.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { truncateToWidth } from 'src/utils/format.js'
import { logError } from 'src/utils/log.js'
import {
  applyTemplateCompletionValue,
  hasMoreTemplateArgsAfterCurrent,
  pickBestTemplateMatch,
  uriTemplateDisplayPrefix,
} from 'src/utils/mcpResourceTemplate.js'
import type { Theme } from 'src/utils/theme.js'

type FileSuggestionSource = {
  type: 'file'
  displayText: string
  description?: string
  path: string
  filename: string
  score?: number
}

type McpResourceSuggestionSource = {
  type: 'mcp_resource'
  displayText: string
  description: string
  server: string
  uri: string
  name: string
}

type McpResourceTemplateSuggestionSource = {
  type: 'mcp_resource_template'
  displayText: string
  description: string
  server: string
  uriTemplate: string
  name: string
}

type AgentSuggestionSource = {
  type: 'agent'
  displayText: string
  description: string
  agentType: string
  color?: keyof Theme
}

type SuggestionSource =
  | FileSuggestionSource
  | McpResourceSuggestionSource
  | McpResourceTemplateSuggestionSource
  | AgentSuggestionSource

/**
 * Creates a unified suggestion item from a source
 */
function createSuggestionFromSource(source: SuggestionSource): SuggestionItem {
  switch (source.type) {
    case 'file':
      return {
        id: `file-${source.path}`,
        displayText: source.displayText,
        description: source.description,
      }
    case 'mcp_resource':
      return {
        id: `mcp-resource-${source.server}__${source.uri}`,
        displayText: source.displayText,
        description: source.description,
      }
    case 'mcp_resource_template':
      return {
        id: `mcp-template::${source.server}__${source.uriTemplate}`,
        displayText: source.displayText,
        description: source.description,
        metadata: { partial: true },
      }
    case 'agent':
      return {
        id: `agent-${source.agentType}`,
        displayText: source.displayText,
        description: source.description,
        color: source.color,
      }
  }
}

const MAX_UNIFIED_SUGGESTIONS = 15
const DESCRIPTION_MAX_LENGTH = 60

function truncateDescription(description: string): string {
  return truncateToWidth(description, DESCRIPTION_MAX_LENGTH)
}

function generateAgentSuggestions(
  agents: AgentDefinition[],
  query: string,
  showOnEmpty = false,
): AgentSuggestionSource[] {
  if (!query && !showOnEmpty) {
    return []
  }

  try {
    const agentSources: AgentSuggestionSource[] = agents.map(agent => ({
      type: 'agent' as const,
      displayText: `${agent.agentType} (agent)`,
      description: truncateDescription(agent.whenToUse),
      agentType: agent.agentType,
      color: getAgentColor(agent.agentType),
    }))

    if (!query) {
      return agentSources
    }

    const queryLower = query.toLowerCase()
    return agentSources.filter(
      agent =>
        agent.agentType.toLowerCase().includes(queryLower) ||
        agent.displayText.toLowerCase().includes(queryLower),
    )
  } catch (error) {
    logError(error as Error)
    return []
  }
}

export async function generateUnifiedSuggestions(
  query: string,
  mcpResources: Record<string, ServerResource[]>,
  agents: AgentDefinition[],
  showOnEmpty = false,
  mcpResourceTemplates: Record<string, ServerResourceTemplate[]> = {},
): Promise<SuggestionItem[]> {
  if (!query && !showOnEmpty) {
    return []
  }

  const [fileSuggestions, agentSources] = await Promise.all([
    generateFileSuggestions(query, showOnEmpty),
    Promise.resolve(generateAgentSuggestions(agents, query, showOnEmpty)),
  ])

  const fileSources: FileSuggestionSource[] = fileSuggestions.map(
    suggestion => ({
      type: 'file' as const,
      displayText: suggestion.displayText,
      description: suggestion.description,
      path: suggestion.displayText, // Use displayText as path for files
      filename: basename(suggestion.displayText),
      score: (suggestion.metadata as { score?: number } | undefined)?.score,
    }),
  )

  const mcpSources: McpResourceSuggestionSource[] = Object.values(mcpResources)
    .flat()
    .map(resource => ({
      type: 'mcp_resource' as const,
      displayText: `${resource.server}:${resource.uri}`,
      description: truncateDescription(
        resource.description || resource.name || resource.uri,
      ),
      server: resource.server,
      uri: resource.uri,
      name: resource.name || resource.uri,
    }))

  const mcpTemplateSources: McpResourceTemplateSuggestionSource[] =
    Object.values(mcpResourceTemplates)
      .flat()
      .map(template => ({
        type: 'mcp_resource_template' as const,
        displayText: `${template.server}:${uriTemplateDisplayPrefix(template.uriTemplate)}`,
        description: truncateDescription(
          template.description || template.name || template.uriTemplate,
        ),
        server: template.server,
        uriTemplate: template.uriTemplate,
        name: template.name || template.uriTemplate,
      }))

  if (!query) {
    const allSources = [
      ...fileSources,
      ...mcpSources,
      ...mcpTemplateSources,
      ...agentSources,
    ]
    return allSources
      .slice(0, MAX_UNIFIED_SUGGESTIONS)
      .map(createSuggestionFromSource)
  }

  const nonFileSources: SuggestionSource[] = [
    ...mcpSources,
    ...mcpTemplateSources,
    ...agentSources,
  ]

  // Score non-file sources with Fuse.js
  // File sources are already scored by Rust/nucleo
  type ScoredSource = { source: SuggestionSource; score: number }
  const scoredResults: ScoredSource[] = []

  // Add file sources with their nucleo scores (already 0-1, lower is better)
  for (const fileSource of fileSources) {
    scoredResults.push({
      source: fileSource,
      score: fileSource.score ?? 0.5, // Default to middle score if missing
    })
  }

  // Score non-file sources with Fuse.js and add them
  if (nonFileSources.length > 0) {
    const fuse = new Fuse(nonFileSources, {
      includeScore: true,
      threshold: 0.6, // Allow more matches through, we'll sort by score
      keys: [
        { name: 'displayText', weight: 2 },
        { name: 'name', weight: 3 },
        { name: 'server', weight: 1 },
        { name: 'description', weight: 1 },
        { name: 'agentType', weight: 3 },
        { name: 'uriTemplate', weight: 2 },
      ],
    })

    const fuseResults = fuse.search(query, { limit: MAX_UNIFIED_SUGGESTIONS })
    for (const result of fuseResults) {
      // Official 2.1.98: only concrete MCP resources get the 0.15 penalty.
      const mcpPenalty = result.item.type === 'mcp_resource' ? 0.15 : 0
      scoredResults.push({
        source: result.item,
        score: (result.score ?? 0.5) + mcpPenalty,
      })
    }
  }

  // Sort all results by score (lower is better) and return top results
  scoredResults.sort((a, b) => a.score - b.score)

  return scoredResults
    .slice(0, MAX_UNIFIED_SUGGESTIONS)
    .map(r => r.source)
    .map(createSuggestionFromSource)
}

/**
 * Official 2.1.98 mj7. `@server:…` completions for resource-template arguments.
 * Returns null when the query is not a template completion (caller falls back
 * to generateUnifiedSuggestions). An empty array means "no values — hide files".
 */
export async function generateMcpResourceTemplateCompletions(
  query: string,
  mcpResourceTemplates: Record<string, ServerResourceTemplate[]>,
  clients: MCPServerConnection[],
): Promise<SuggestionItem[] | null> {
  const colon = query.indexOf(':')
  if (colon === -1) return null
  const server = query.slice(0, colon)
  const typed = query.slice(colon + 1)
  const templates = mcpResourceTemplates[server]
  if (!templates || templates.length === 0) return null

  const match = pickBestTemplateMatch(typed, templates)
  if (!match) {
    if (!typed) return null
    const prefixHits = templates.filter(template =>
      template.uriTemplate.startsWith(typed),
    )
    if (prefixHits.length === 0) return null
    return prefixHits.slice(0, MAX_UNIFIED_SUGGESTIONS).map(template => ({
      id: `mcp-template::${server}__${template.uriTemplate}`,
      displayText: `${server}:${uriTemplateDisplayPrefix(template.uriTemplate)}`,
      description: truncateDescription(
        template.description || template.name || template.uriTemplate,
      ),
      metadata: { partial: true },
    }))
  }

  const client = clients.find(c => c.name === server && c.type === 'connected')
  if (!client) return []

  const values = await completeResourceTemplate(
    client,
    match.template.uriTemplate,
    match.argName,
    match.argValue,
    match.resolvedArgs,
  )
  if (values.length === 0) return []

  const description = truncateDescription(
    match.template.description || match.template.name || '',
  )
  const partial = hasMoreTemplateArgsAfterCurrent(match)
  return values.slice(0, MAX_UNIFIED_SUGGESTIONS).map(value => {
    const filled = applyTemplateCompletionValue(typed, match, value)
    return {
      id: `mcp-template-value::${server}__${filled}`,
      displayText: filled.slice(match.valueStartIndex),
      description,
      metadata: { partial, replacement: `${server}:${filled}` },
    }
  })
}
