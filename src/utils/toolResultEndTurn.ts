/**
 * Official 2.1.187 — detect tool/MCP results that end the turn without
 * re-invoking the model (StructuredOutput `endsTurn`, MCP `_meta['claude/endTurn']`).
 */

export type ToolResultEndTurnSource = 'tool' | 'mcp_meta'

export type McpMetaLike = {
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
} | null | undefined

/** Frozen MCP meta carrying only the end-turn signal (for subagent passthrough). */
export const MCP_END_TURN_META: { _meta: { 'claude/endTurn': true } } =
  Object.freeze({
    _meta: Object.freeze({ ['claude/endTurn']: true as const }),
  })

export function isMcpEndTurnMeta(mcpMeta: McpMetaLike): boolean {
  return mcpMeta?._meta?.['claude/endTurn'] === true
}

/**
 * Official `D_o` — main thread keeps full mcpMeta; subagents only keep the
 * frozen end-turn marker when present.
 */
export function mcpMetaForToolResultMessage(
  agentId: string | undefined,
  mcpMeta: McpMetaLike,
): McpMetaLike {
  if (!agentId) return mcpMeta
  return isMcpEndTurnMeta(mcpMeta) ? MCP_END_TURN_META : undefined
}

/**
 * Official `R_o` — returns `'tool' | 'mcp_meta'` when this user tool_result
 * should end the turn; false if not an end-turn result or any result is_error.
 */
export function getToolResultEndTurnSource(
  message: unknown,
): ToolResultEndTurnSource | false {
  if (!message || typeof message !== 'object') return false
  const m = message as {
    type?: string
    toolEndsTurn?: boolean
    mcpMeta?: McpMetaLike
    message?: { content?: unknown }
  }
  if (m.type !== 'user') return false
  const source: ToolResultEndTurnSource | false = m.toolEndsTurn
    ? 'tool'
    : isMcpEndTurnMeta(m.mcpMeta)
      ? 'mcp_meta'
      : false
  if (!source) return false
  const content = m.message?.content
  if (
    Array.isArray(content) &&
    content.some(
      (block: { type?: string; is_error?: boolean }) =>
        block.type === 'tool_result' && block.is_error === true,
    )
  ) {
    return false
  }
  return source
}
