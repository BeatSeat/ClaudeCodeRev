import { z } from 'zod/v4'
import {
  buildTool,
  type ToolDef,
} from '../../Tool.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { getPendingMcpServerNames } from '../../services/mcp/mcpPendingClients.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sleep } from '../../utils/sleep.js'
import { modelSupportsToolReference } from '../../utils/toolSearch.js'
import {
  WAIT_FOR_MCP_SERVERS_TOOL_NAME,
} from './constants.js'
import { DESCRIPTION } from './prompt.js'

/**
 * Official 2.1.132 `WaitForMcpServers` (bundle var `h47` / gate
 * `tengu_mcp_pending_call`). Lets the agent block (up to MCP_WAIT_DEADLINE_MS)
 * while MCP servers finish connecting so their tools land in the tool list.
 */
const MCP_WAIT_DEADLINE_MS = 5000
const MCP_POLL_INTERVAL_MS = 50

export const inputSchema = lazySchema(() =>
  z.object({
    servers: z
      .array(z.string())
      .optional()
      .describe('Server names to wait for (default: all pending)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    ready: z.boolean(),
    connected: z.array(z.string()),
    failed: z.array(z.string()),
    stillPending: z.array(z.string()),
    needsAuth: z.array(z.string()),
    disabled: z.array(z.string()),
    unknown: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * Official 2.1.132 `yf6`: the tool is only surfaced when tool search is on
 * (`tengu_ashen_kelp`), the current model does NOT support tool_reference
 * (`PZH`), and at least one MCP server is still pending.
 */
function isWaitForMcpServersEnabled(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_ashen_kelp', false)) {
    return false
  }
  if (modelSupportsToolReference(getMainLoopModel())) {
    return false
  }
  return getPendingMcpServerNames().length > 0
}

function renderToolUseMessage(
  input: Partial<z.infer<ReturnType<typeof inputSchema>>>,
): string {
  const servers = input.servers?.join(', ')
  return servers
    ? `Wait for MCP servers to connect: ${servers}`
    : 'Wait for pending MCP servers to connect'
}

export const WaitForMcpServersTool = buildTool({
  isEnabled: isWaitForMcpServersEnabled,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  name: WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  maxResultSizeChars: 10_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, context) {
    // Re-read live MCP client state on every poll so servers that settle
    // mid-wait are picked up (bundle: refreshMcpClients / getMcp().clients).
    const getClientList = (): typeof context.options.mcpClients =>
      context.getAppState().mcp.clients ?? context.options.mcpClients
    const requestedServers = input.servers?.length
      ? input.servers
      : getPendingMcpServerNames()
    const requestedNormalized = new Set(
      requestedServers.map(normalizeNameForMCP),
    )
    const matchingClients = () =>
      getClientList().filter(
        client =>
          requestedServers.includes(client.name) ||
          requestedNormalized.has(normalizeNameForMCP(client.name)),
      )

    const startedAt = Date.now()
    const deadline = startedAt + MCP_WAIT_DEADLINE_MS
    while (
      matchingClients().some(client => client.type === 'pending') &&
      Date.now() < deadline &&
      !context.abortController.signal.aborted
    ) {
      await sleep(MCP_POLL_INTERVAL_MS, context.abortController.signal)
    }

    const waitMs = Date.now() - startedAt
    const settledClients = matchingClients()
    const connected: string[] = []
    const failed: string[] = []
    const stillPending: string[] = []
    const needsAuth: string[] = []
    const disabled: string[] = []
    for (const client of settledClients) {
      switch (client.type) {
        case 'connected':
          connected.push(client.name)
          break
        case 'failed':
          failed.push(client.name)
          break
        case 'pending':
          stillPending.push(client.name)
          break
        case 'needs-auth':
          needsAuth.push(client.name)
          break
        case 'disabled':
          disabled.push(client.name)
          break
        default:
          break
      }
    }
    const matchedNormalized = new Set(
      settledClients.map(client => normalizeNameForMCP(client.name)),
    )
    const unknown = requestedServers.filter(
      name => !matchedNormalized.has(normalizeNameForMCP(name)),
    )
    const ready =
      stillPending.length === 0 &&
      failed.length === 0 &&
      needsAuth.length === 0 &&
      disabled.length === 0 &&
      unknown.length === 0

    logForDebugging(
      `[WaitForMcpServers] waited=${waitMs}ms connected=${connected.join(',')} failed=${failed.join(',')} pending=${stillPending.join(',')} needsAuth=${needsAuth.join(',')} disabled=${disabled.join(',')} unknown=${unknown.join(',')}`,
    )
    logEvent('tengu_mcp_pending_call', {
      requestedCount: requestedServers.length,
      connectedCount: connected.length,
      failedCount: failed.length,
      pendingCount: stillPending.length,
      needsAuthCount: needsAuth.length,
      disabledCount: disabled.length,
      unknownCount: unknown.length,
      waitMs,
      matched: ready,
      matchType: 'wait' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      success: ready,
    })

    return {
      data: {
        ready,
        connected,
        failed,
        stillPending,
        needsAuth,
        disabled,
        unknown,
      },
    }
  },
  renderToolUseMessage,
  userFacingName() {
    return 'MCP Wait For Servers'
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID) {
    const lines = [
      `ready: ${content.ready}`,
      content.connected.length
        ? `Connected (their tools are now available \u2014 call them directly): ${content.connected.join(', ')}`
        : '',
      content.failed.length
        ? `Failed to connect: ${content.failed.join(', ')}`
        : '',
      content.stillPending.length
        ? `Still connecting (try again or proceed without): ${content.stillPending.join(', ')}`
        : '',
      content.needsAuth.length
        ? `Needs authentication (ask the user to run /mcp): ${content.needsAuth.join(', ')}`
        : '',
      content.disabled.length
        ? `Disabled (ask the user to enable via /mcp): ${content.disabled.join(', ')}`
        : '',
      content.unknown.length
        ? `Unknown (no MCP server with this name is configured): ${content.unknown.join(', ')}`
        : '',
    ].filter(Boolean)
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: lines.join('\n'),
      is_error: !content.ready,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
