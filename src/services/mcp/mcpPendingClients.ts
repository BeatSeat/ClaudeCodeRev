import type { MCPServerConnection } from './types.js'

/**
 * Global registry of the live MCP client list.
 *
 * Official 2.1.132 `d28`/`JEH`/`IjH`: the MCP-connection effect registers a
 * `() => store.getState().mcp.clients` getter so non-React code (e.g. the
 * WaitForMcpServers tool's `isEnabled()`) can read the current client list
 * without a React context. Wired in useManageMCPConnections; cleared on
 * unmount.
 */
let currentClientsGetter: (() => MCPServerConnection[]) | undefined

export function setMcpClientsGetter(
  getter: (() => MCPServerConnection[]) | undefined,
): void {
  currentClientsGetter = getter
}

export function getMcpClients(): MCPServerConnection[] {
  return currentClientsGetter?.() ?? []
}

/** Official 2.1.132 `y47`: names of MCP servers still `pending`. */
export function getPendingMcpServerNames(): string[] {
  return getMcpClients()
    .filter(client => client.type === 'pending')
    .map(client => client.name)
}
