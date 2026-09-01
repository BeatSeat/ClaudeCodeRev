import { filterMcpServersByPolicy } from '../services/mcp/config.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import {
  type AgentDefinition,
  agentMcpSpecsToScopedConfigs,
} from '../tools/AgentTool/loadAgentsDir.js'
import { isBareMode } from './envUtils.js'

type MergeAgentFrontmatterMcpOptions = {
  strictMcpConfig?: boolean
  onBlocked?: (blocked: string[]) => void
}

/**
 * Official 2.1.117 TFH: merge --agent frontmatter mcpServers into the
 * already-resolved dynamic MCP map. Existing dynamic entries win.
 */
export function mergeAgentFrontmatterMcpConfig(
  existing: Record<string, ScopedMcpServerConfig>,
  agent: AgentDefinition | undefined,
  options?: MergeAgentFrontmatterMcpOptions,
): Record<string, ScopedMcpServerConfig> {
  if (!agent || options?.strictMcpConfig || isBareMode()) {
    return existing
  }
  const fromAgent = agentMcpSpecsToScopedConfigs(agent)
  if (Object.keys(fromAgent).length === 0) {
    return existing
  }
  const { allowed, blocked } = filterMcpServersByPolicy(fromAgent)
  if (blocked.length > 0) {
    options?.onBlocked?.(blocked)
  }
  return { ...allowed, ...existing }
}
