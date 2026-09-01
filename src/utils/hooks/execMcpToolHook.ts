import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { McpToolHook } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'

const DEFAULT_MCP_TOOL_HOOK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Interpolate `${path}` tokens in mcp_tool hook input from the hook input JSON.
 * 118 `Rc1`: walk dotted paths; objects stringify; missing/null become "".
 */
export function interpolateMcpToolHookInput(
  value: unknown,
  hookInput: unknown,
): unknown {
  const lookup = (path: string): unknown => {
    let current: unknown = hookInput
    for (const key of path.split('.')) {
      if (current == null || typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[key]
    }
    return current
  }

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(
        /\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g,
        (_m, path: string) => {
          const resolved = lookup(path)
          if (resolved === undefined || resolved === null) return ''
          return typeof resolved === 'object'
            ? jsonStringify(resolved)
            : String(resolved)
        },
      )
    }
    if (Array.isArray(node)) {
      return node.map(walk)
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child)
      }
      return out
    }
    return node
  }

  return walk(value)
}

export async function execMcpToolHook(
  hook: McpToolHook,
  hookEvent: HookEvent,
  hookInput: unknown,
  mcpClients: readonly MCPServerConnection[] | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  ok: boolean
  body: string
  error?: string
  aborted?: boolean
}> {
  const clients = mcpClients
  if (clients === undefined) {
    const error = `mcp_tool hooks are not available for the '${hookEvent}' hook event (no MCP client context)`
    logForDebugging(`Hooks: mcp_tool hook skipped — ${error}`, {
      level: 'warn',
    })
    return { ok: false, body: '', error }
  }

  const server = clients.find(c => c.name === hook.server)
  if (!server || server.type !== 'connected') {
    const error = `MCP server '${hook.server}' not connected`
    logForDebugging(`Hooks: mcp_tool hook skipped — ${error}`, {
      level: 'warn',
    })
    return { ok: false, body: '', error }
  }

  const args = hook.input
    ? (interpolateMcpToolHookInput(hook.input, hookInput) as Record<
        string,
        unknown
      >)
    : {}
  const timeoutMs = hook.timeout
    ? hook.timeout * 1000
    : DEFAULT_MCP_TOOL_HOOK_TIMEOUT_MS
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })

  try {
    logForDebugging(
      `Hooks: mcp_tool calling ${hook.server}/${hook.tool} with ${Object.keys(args).length} arg(s)`,
    )
    const result = await server.client.callTool(
      { name: hook.tool, arguments: args },
      CallToolResultSchema,
      { signal: abortSignal, timeout: timeoutMs },
    )
    cleanup()
    const body = Array.isArray(result.content)
      ? result.content
          .map(block =>
            block.type === 'text' ? block.text : `[${block.type}]`,
          )
          .join('\n')
      : ''
    if (result.isError) {
      return { ok: false, body, error: body || 'MCP tool returned an error' }
    }
    return { ok: true, body }
  } catch (err) {
    cleanup()
    if (abortSignal.aborted) {
      return { ok: false, body: '', aborted: true }
    }
    const msg = errorMessage(err)
    logForDebugging(`Hooks: mcp_tool hook error: ${msg}`, { level: 'error' })
    return { ok: false, body: '', error: msg }
  }
}
