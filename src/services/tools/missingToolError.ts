import type { Tools, ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import { REPL_ONLY_TOOLS } from '../../tools/REPLTool/constants.js'
import { getAllBaseTools } from '../../tools.js'

/**
 * Add actionable context when a known tool is absent from the active pool.
 * Unknown MCP and misspelled tool names intentionally retain the generic
 * error because there is no reliable recovery guidance for them.
 */
export function formatMissingToolError(
  toolName: string,
  availableTools: Tools,
  toolUseContext: ToolUseContext,
): string {
  const baseError = `Error: No such tool available: ${toolName}`

  if (REPL_ONLY_TOOLS.has(toolName)) {
    return `${baseError}. This tool can only be used inside the REPL tool.`
  }

  const knownTool = findToolByName(getAllBaseTools(), toolName)
  if (!knownTool) {
    return baseError
  }

  if (toolUseContext.agentId) {
    return `${baseError}. This tool is not available inside subagents.`
  }

  if (!findToolByName(availableTools, toolName)) {
    return `${baseError}. This tool is disabled in the current context. Use one of the available tools instead.`
  }

  return baseError
}
