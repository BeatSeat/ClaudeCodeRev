/**
 * MCP subcommand handlers — extracted from main.tsx for lazy loading.
 * These are dynamically imported only when the corresponding `claude mcp *` command runs.
 */

import { stat } from 'fs/promises'
import pMap from 'p-map'
import { cwd } from 'process'
import React from 'react'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import { MCPServerDesktopImportDialog } from '../../components/MCPServerDesktopImportDialog.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  AuthenticationCancelledError,
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
  getAnthropicHostedMcpMessage,
  getMcpClientConfig,
  isAnthropicHostedMcpUrl,
  performMCPOAuthFlow,
  readClientSecret,
  revokeServerTokens,
  saveMcpClientSecret,
} from '../../services/mcp/auth.js'
import {
  buildClaudeAiConnectorAuthUrl,
} from '../../services/mcp/claudeai.js'
import {
  clearMcpAuthCacheEntry,
  connectToServer,
  getMcpServerConnectionBatchSize,
} from '../../services/mcp/client.js'
import {
  addMcpConfig,
  doesEnterpriseMcpConfigExist,
  getAllMcpConfigs,
  getMcpConfigByName,
  getMcpConfigsByScope,
  isMcpServerAllowedByPolicy,
  isMcpServerDisabled,
  removeMcpConfig,
} from '../../services/mcp/config.js'
import { isAnthropicDesignMcpUrl } from '../../services/mcp/officialRegistry.js'
import type {
  ConfigScope,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  getRawProjectMcpServerStatus,
  getScopeLabel,
} from '../../services/mcp/utils.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
} from '../../utils/config.js'
import { stopCapturingEarlyInput } from '../../utils/earlyInput.js'
import { AbortError, errorMessage, isFsInaccessible } from '../../utils/errors.js'
import { closestCommandName } from '../../utils/fuzzyCommandMatch.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { safeParseJSON } from '../../utils/json.js'
import { getPlatform } from '../../utils/platform.js'
import { isRestrictedToPluginOnly } from '../../utils/settings/pluginOnlyPolicy.js'
import { cliError, cliOk } from '../exit.js'

/** Official 2.1.154 `ZK9`. */
const MCP_PENDING_APPROVAL = '⏸ Pending approval (run `claude` to approve)'
/** Official 2.1.154 `ePz`. */
const MCP_REJECTED = '✗ Rejected (see disabledMcpjsonServers in settings)'

async function checkMcpServerHealth(
  name: string,
  server: ScopedMcpServerConfig,
): Promise<string> {
  try {
    const result = await connectToServer(name, server)
    if (result.type === 'connected') {
      return '✓ Connected'
    } else if (result.type === 'needs-auth') {
      return '! Needs authentication'
    } else {
      return '✗ Failed to connect'
    }
  } catch (_error) {
    return '✗ Connection error'
  }
}

// mcp serve (lines 4512–4532)
export async function mcpServeHandler({
  debug,
  verbose,
}: {
  debug?: boolean
  verbose?: boolean
}): Promise<void> {
  const providedCwd = cwd()
  logEvent('tengu_mcp_start', {})

  try {
    await stat(providedCwd)
  } catch (error) {
    if (isFsInaccessible(error)) {
      cliError(`Error: Directory ${providedCwd} does not exist`)
    }
    throw error
  }

  try {
    const { setup } = await import('../../setup.js')
    await setup(providedCwd, 'default', false, false, undefined, false)
    const { startMCPServer } = await import('../../entrypoints/mcp.js')
    await startMCPServer(providedCwd, debug ?? false, verbose ?? false)
  } catch (error) {
    cliError(`Error: Failed to start MCP server: ${error}`)
  }
}

// mcp remove (lines 4545–4635)
export async function mcpRemoveHandler(
  name: string,
  options: { scope?: string },
): Promise<void> {
  // Look up config before removing so we can clean up secure storage
  const serverBeforeRemoval = getMcpConfigByName(name)

  const cleanupSecureStorage = () => {
    if (
      serverBeforeRemoval &&
      (serverBeforeRemoval.type === 'sse' ||
        serverBeforeRemoval.type === 'http')
    ) {
      clearServerTokensFromLocalStorage(name, serverBeforeRemoval)
      clearMcpClientConfig(name, serverBeforeRemoval)
    }
  }

  try {
    if (options.scope) {
      const scope = ensureConfigScope(options.scope)
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope:
          scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      await removeMcpConfig(name, scope)
      cleanupSecureStorage()
      process.stdout.write(`Removed MCP server ${name} from ${scope} config\n`)
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`)
    }

    // If no scope specified, check where the server exists
    const projectConfig = getCurrentProjectConfig()
    const globalConfig = getGlobalConfig()

    // Check if server exists in project scope (.mcp.json)
    const { servers: projectServers } = getMcpConfigsByScope('project')
    const mcpJsonExists = !!projectServers[name]

    // Count how many scopes contain this server
    const scopes: Array<Exclude<ConfigScope, 'dynamic'>> = []
    if (projectConfig.mcpServers?.[name]) scopes.push('local')
    if (mcpJsonExists) scopes.push('project')
    if (globalConfig.mcpServers?.[name]) scopes.push('user')

    if (scopes.length === 0) {
      cliError(`No MCP server found with name: "${name}"`)
    } else if (scopes.length === 1) {
      // Server exists in only one scope, remove it
      const scope = scopes[0]!
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope:
          scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      await removeMcpConfig(name, scope)
      cleanupSecureStorage()
      process.stdout.write(
        `Removed MCP server "${name}" from ${scope} config\n`,
      )
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`)
    } else {
      // Server exists in multiple scopes
      process.stderr.write(`MCP server "${name}" exists in multiple scopes:\n`)
      scopes.forEach(scope => {
        process.stderr.write(
          `  - ${getScopeLabel(scope)} (${describeMcpConfigFilePath(scope)})\n`,
        )
      })
      process.stderr.write('\nTo remove from a specific scope, use:\n')
      scopes.forEach(scope => {
        process.stderr.write(`  claude mcp remove "${name}" -s ${scope}\n`)
      })
      cliError()
    }
  } catch (error) {
    cliError((error as Error).message)
  }
}

// mcp list (lines 4641–4688)
export async function mcpListHandler(): Promise<void> {
  logEvent('tengu_mcp_list', {})
  const { servers: configs, pendingProjectServers } = await getAllMcpConfigs({
    includePendingProjectServers: true,
  })
  if (Object.keys(configs).length === 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      'No MCP servers configured. Use `claude mcp add` to add a server.',
    )
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Checking MCP server health...\n')

    // Check servers concurrently
    const entries = Object.entries(configs)
    const results = await pMap(
      entries,
      async ([name, server]) => ({
        name,
        server,
        status: pendingProjectServers.has(name)
          ? MCP_PENDING_APPROVAL
          : await checkMcpServerHealth(name, server),
      }),
      { concurrency: getMcpServerConnectionBatchSize() },
    )

    for (const { name, server, status } of results) {
      // Intentionally excluding sse-ide servers here since they're internal
      if (server.type === 'sse') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (SSE) - ${status}`)
      } else if (server.type === 'http') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (HTTP) - ${status}`)
      } else if (server.type === 'claudeai-proxy') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} - ${status}`)
      } else if (!server.type || server.type === 'stdio') {
        const args = Array.isArray(server.args) ? server.args : []
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.command} ${args.join(' ')} - ${status}`)
      }
    }
  }
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0)
}

// mcp get (lines 4694–4786)
export async function mcpGetHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_get', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  const { servers, pendingProjectServers } = await getAllMcpConfigs({
    includePendingProjectServers: true,
  })
  let server = servers[name]
  let pendingKind: 'pending' | 'rejected' | null = pendingProjectServers.has(
    name,
  )
    ? 'pending'
    : null
  if (!server) {
    const { servers: projectServers } = getMcpConfigsByScope('project')
    const project = projectServers[name]
    if (
      project &&
      !isRestrictedToPluginOnly('mcp') &&
      !doesEnterpriseMcpConfigExist() &&
      isMcpServerAllowedByPolicy(name, project) &&
      getRawProjectMcpServerStatus(name) === 'rejected'
    ) {
      server = project
      pendingKind = 'rejected'
    }
  }
  if (!server) {
    cliError(`No MCP server found with name: ${name}`)
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`${name}:`)
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Scope: ${getScopeLabel(server.scope)}`)

  const status =
    pendingKind === 'pending'
      ? MCP_PENDING_APPROVAL
      : pendingKind === 'rejected'
        ? MCP_REJECTED
        : await checkMcpServerHealth(name, server)
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Status: ${status}`)

  // Intentionally excluding sse-ide servers here since they're internal
  if (server.type === 'sse') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: sse`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`)
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:')
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${value}`)
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = []
      if (server.oauth.clientId) {
        parts.push('client_id configured')
        const clientConfig = getMcpClientConfig(name, server)
        if (clientConfig?.clientSecret) parts.push('client_secret configured')
      }
      if (server.oauth.callbackPort)
        parts.push(`callback_port ${server.oauth.callbackPort}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`)
    }
  } else if (server.type === 'http') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: http`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`)
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:')
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${value}`)
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = []
      if (server.oauth.clientId) {
        parts.push('client_id configured')
        const clientConfig = getMcpClientConfig(name, server)
        if (clientConfig?.clientSecret) parts.push('client_secret configured')
      }
      if (server.oauth.callbackPort)
        parts.push(`callback_port ${server.oauth.callbackPort}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`)
    }
  } else if (server.type === 'stdio') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: stdio`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Command: ${server.command}`)
    const args = Array.isArray(server.args) ? server.args : []
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Args: ${args.join(' ')}`)
    if (server.env) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Environment:')
      for (const [key, value] of Object.entries(server.env)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}=${value}`)
      }
    }
  }
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(
    `\nTo remove this server, run: claude mcp remove "${name}" -s ${server.scope}`,
  )
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0)
}

// mcp add-json (lines 4801–4870)
export async function mcpAddJsonHandler(
  name: string,
  json: string,
  options: { scope?: string; clientSecret?: true },
): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope)
    const parsedJson = safeParseJSON(json)

    // Read secret before writing config so cancellation doesn't leave partial state
    const needsSecret =
      options.clientSecret &&
      parsedJson &&
      typeof parsedJson === 'object' &&
      'type' in parsedJson &&
      (parsedJson.type === 'sse' || parsedJson.type === 'http') &&
      'url' in parsedJson &&
      typeof parsedJson.url === 'string' &&
      'oauth' in parsedJson &&
      parsedJson.oauth &&
      typeof parsedJson.oauth === 'object' &&
      'clientId' in parsedJson.oauth
    const clientSecret = needsSecret ? await readClientSecret() : undefined

    await addMcpConfig(name, parsedJson, scope)

    const transportType =
      parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson
        ? String(parsedJson.type || 'stdio')
        : 'stdio'

    if (
      clientSecret &&
      parsedJson &&
      typeof parsedJson === 'object' &&
      'type' in parsedJson &&
      (parsedJson.type === 'sse' || parsedJson.type === 'http') &&
      'url' in parsedJson &&
      typeof parsedJson.url === 'string'
    ) {
      saveMcpClientSecret(
        name,
        { type: parsedJson.type, url: parsedJson.url },
        clientSecret,
      )
    }

    logEvent('tengu_mcp_add', {
      scope:
        scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      type: transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(`Added ${transportType} MCP server ${name} to ${scope} config`)
  } catch (error) {
    cliError((error as Error).message)
  }
}

// mcp add-from-claude-desktop (lines 4881–4927)
export async function mcpAddFromDesktopHandler(options: {
  scope?: string
}): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope)
    const platform = getPlatform()

    logEvent('tengu_mcp_add', {
      scope:
        scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      platform:
        platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'desktop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    const { readClaudeDesktopMcpServers } = await import(
      '../../utils/claudeDesktop.js'
    )
    const servers = await readClaudeDesktopMcpServers()

    if (Object.keys(servers).length === 0) {
      cliOk(
        'No MCP servers found in Claude Desktop configuration or configuration file does not exist.',
      )
    }

    const { unmount } = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <MCPServerDesktopImportDialog
            servers={servers}
            scope={scope}
            onDone={() => {
              unmount()
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
      { exitOnCtrlC: true },
    )
  } catch (error) {
    cliError((error as Error).message)
  }
}

// mcp reset-project-choices (lines 4935–4952)
export async function mcpResetChoicesHandler(): Promise<void> {
  logEvent('tengu_mcp_reset_mcpjson_choices', {})
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
  }))
  cliOk(
    'All project-scoped (.mcp.json) server approvals and rejections have been reset.\n' +
      'You will be prompted for approval next time you start Claude Code.',
  )
}

type Meta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

/** Official 2.1.186 `cT` / `Qu` / `toe` for cli_mcp_* telemetry. */
function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', { feature_name: featureName as Meta })
}
function featureBad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_bad', {
    feature_name: featureName as Meta,
    error_code: errorCode as Meta,
  })
}
function featureSad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_sad', {
    feature_name: featureName as Meta,
    error_code: errorCode as Meta,
  })
}

/** Official 2.1.186 `Yg` — only emit `claude …` when the name is shell-safe. */
function formatSafeClaudeCommand(
  subcommand: string,
  name: string,
): string | null {
  if (!/^\w[\w.@-]*$/.test(name)) return null
  return `claude ${subcommand} ${name}`
}

/** Official 2.1.186 `sOo` / `NQn` — not-found message with fuzzy suggestion. */
function mcpServerNotFoundMessage(
  name: string,
  configuredNames: string[],
  hasPending: boolean,
): string {
  const pendingNote =
    '.mcp.json servers are awaiting approval — run `claude` in this directory to review them.'
  if (hasPending && configuredNames.length === 0) {
    return `No MCP server named "${name}". ${pendingNote}`
  }
  const suggestion = closestCommandName(
    name,
    configuredNames.map(n => ({ name: n })),
  )
  let base: string
  if (suggestion) {
    base = `No MCP server named "${name}". Did you mean "${suggestion}"? Run \`claude mcp list\` to see all.`
  } else if (configuredNames.length === 0) {
    base = `No MCP server named "${name}". Run \`claude mcp add\` to add one.`
  } else {
    const max = 8
    const sorted = [...configuredNames].sort()
    const shown = sorted.slice(0, max).join(', ')
    const more =
      sorted.length > max
        ? ` (and ${sorted.length - max} more — run \`claude mcp list\` to see all)`
        : ''
    base = `No MCP server named "${name}". Configured servers: ${shown}${more}`
  }
  return hasPending ? `${base} (${pendingNote})` : base
}

/** Official 2.1.186 `dZe`. */
function hasStaticAuthHeader(config: ScopedMcpServerConfig): boolean {
  const headers = 'headers' in config ? config.headers : undefined
  return Object.keys(headers ?? {}).some(
    key => key.toLowerCase() === 'authorization',
  )
}

/** Official 2.1.186 `MVl`. */
function mcpLoginAuthMethod(
  config: ScopedMcpServerConfig,
): 'static_auth_header' | 'first_party_auth' | null {
  if (hasStaticAuthHeader(config)) return 'static_auth_header'
  if (
    'url' in config &&
    typeof config.url === 'string' &&
    isAnthropicDesignMcpUrl(config.url) &&
    isClaudeAISubscriber() &&
    !!getClaudeAIOAuthTokens()?.accessToken
  ) {
    return 'first_party_auth'
  }
  return null
}

/** Official 2.1.186 `RVl`. */
function formatAuthUrlPrompt(browser: boolean, url: string): string {
  return `${browser ? "If the browser didn't open, visit:" : 'Visit this URL to authorize:'}
  ${createHyperlink(url)}

`
}

type McpLoginKind =
  | { kind: 'claudeai-proxy'; config: ScopedMcpServerConfig }
  | { kind: 'unsupported-transport'; transport: string }
  | {
      kind: 'anthropic-hosted'
      config: ScopedMcpServerConfig
      message: string
    }
  | {
      kind: 'oauth'
      config: ScopedMcpServerConfig & (McpSSEServerConfig | McpHTTPServerConfig)
    }

/** Official 2.1.186 `TV`. */
function classifyMcpLoginServer(
  name: string,
  config: ScopedMcpServerConfig,
): McpLoginKind {
  if (config.type === 'claudeai-proxy') {
    return { kind: 'claudeai-proxy', config }
  }
  if (config.type !== 'sse' && config.type !== 'http') {
    return {
      kind: 'unsupported-transport',
      transport: config.type ?? 'stdio',
    }
  }
  if (isAnthropicHostedMcpUrl(config.url)) {
    return {
      kind: 'anthropic-hosted',
      config,
      message: getAnthropicHostedMcpMessage(name, { scope: config.scope }),
    }
  }
  return {
    kind: 'oauth',
    config: config as ScopedMcpServerConfig &
      (McpSSEServerConfig | McpHTTPServerConfig),
  }
}

/** Official 2.1.186 `PVl` — resolve server for mcp login/logout. */
async function resolveMcpServerForCliAuth(
  name: string,
  featureName: string,
): Promise<ScopedMcpServerConfig> {
  const {
    servers,
    pendingProjectServers,
  } = await getAllMcpConfigs({
    includePendingProjectServers: true,
  })

  // Rejected .mcp.json servers are not in getAllMcpConfigs by default —
  // look them up the same way mcpGetHandler does.
  const rejectedProjectServers = new Set<string>()
  {
    const { servers: projectServers } = getMcpConfigsByScope('project')
    for (const projectName of Object.keys(projectServers)) {
      if (
        !isRestrictedToPluginOnly('mcp') &&
        !doesEnterpriseMcpConfigExist() &&
        projectServers[projectName] &&
        isMcpServerAllowedByPolicy(projectName, projectServers[projectName]!) &&
        getRawProjectMcpServerStatus(projectName) === 'rejected'
      ) {
        rejectedProjectServers.add(projectName)
        if (!(projectName in servers)) {
          servers[projectName] = projectServers[projectName]!
        }
      }
    }
  }

  const server = servers[name]
  if (!server) {
    featureBad(featureName, 'not_found')
    const visible = Object.keys(servers).filter(
      n => !pendingProjectServers.has(n) && !rejectedProjectServers.has(n),
    )
    return cliError(
      mcpServerNotFoundMessage(name, visible, pendingProjectServers.size > 0),
    )
  }
  if (rejectedProjectServers.has(name)) {
    featureBad(featureName, 'rejected')
    return cliError(
      `"${name}" is from .mcp.json and was rejected. Run \`claude mcp reset-project-choices\` to review it again.`,
    )
  }
  if (pendingProjectServers.has(name)) {
    featureBad(featureName, 'pending_approval')
    return cliError(
      `"${name}" is from .mcp.json and awaiting approval. Run \`claude\` in this directory to review it first.`,
    )
  }
  // Official 2.1.186 PVl: surface loader configError before returning the server.
  const configError = (server as { configError?: string }).configError
  if (configError) {
    featureBad(featureName, 'config_error')
    return cliError(`"${name}" has a configuration problem: ${configError}`)
  }
  return server
}

/**
 * Official 2.1.186 `EPf` — `claude mcp login <name> [--no-browser]`.
 */
export async function mcpLoginHandler(
  name: string,
  options: { browser?: boolean },
): Promise<void> {
  logEvent('tengu_mcp_login', {})
  // Commander `--no-browser` → browser=false; default browser=true.
  const browser = options.browser !== false

  const server = await resolveMcpServerForCliAuth(name, 'cli_mcp_login')
  const classified = classifyMcpLoginServer(name, server)

  switch (classified.kind) {
    case 'claudeai-proxy': {
      const authUrl = buildClaudeAiConnectorAuthUrl(
        classified.config as { id?: string },
      )
      if (!authUrl) {
        featureBad('cli_mcp_login', 'claudeai_no_auth_url')
        return cliError(
          `Couldn't build the claude.ai authorization link for "${name}". Make sure you're signed in (\`claude login\`).`,
        )
      }
      logEvent('tengu_claudeai_mcp_auth_started', {})
      if (browser) {
        process.stdout.write(`Opening browser to authorize "${name}"\u2026\n`)
        await openBrowser(authUrl)
      }
      process.stdout.write(
        formatAuthUrlPrompt(browser, authUrl) +
          `Once authorized on claude.ai, the connector will be available the next time you start Claude Code.\n`,
      )
      await clearMcpAuthCacheEntry(name)
      featureOk('cli_mcp_login')
      return cliOk()
    }
    case 'unsupported-transport':
      featureBad('cli_mcp_login', 'unsupported_transport')
      return cliError(
        `"${name}" doesn't support OAuth login \u2014 it's only available for HTTP and SSE servers.`,
      )
    case 'anthropic-hosted':
      featureBad('cli_mcp_login', 'anthropic_hosted_blocked')
      return cliError(classified.message)
    case 'oauth': {
      const method = mcpLoginAuthMethod(classified.config)
      if (method === 'static_auth_header') {
        featureBad('cli_mcp_login', 'static_auth_header')
        return cliError(
          `"${name}" authenticates with the \`Authorization\` header in its configuration, so there's no separate login. Update that header to change its credentials.`,
        )
      }
      if (method === 'first_party_auth') {
        featureBad('cli_mcp_login', 'first_party_auth')
        return cliError(
          `"${name}" authenticates automatically with your Claude login. Run \`claude login\` if you're not signed in.`,
        )
      }

      process.stdout.write(`Starting authentication for "${name}"\u2026\n`)
      const pastePrompt = 'Or paste the redirect URL here: '
      const abortController = new AbortController()
      let rl: ReadlineInterface | undefined
      let noTtyStdin = false
      // Keep the process alive while waiting for the OAuth callback.
      const keepAlive = setInterval(() => {}, 60000)
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => reject(new AbortError()),
          { once: true },
        )
      })
      abortPromise.catch(() => {})

      try {
        await revokeServerTokens(name, classified.config, {
          preserveStepUpState: true,
        })
        await Promise.race([
          abortPromise,
          performMCPOAuthFlow(
            name,
            classified.config,
            (authUrl: string) => {
              process.stdout.write(
                formatAuthUrlPrompt(browser, authUrl) +
                  `Waiting for authorization\u2026 (^C to cancel)\n`,
              )
              rl?.prompt()
            },
            abortController.signal,
            {
              skipBrowserOpen: !browser,
              onWaitingForCallback: submit => {
                if (!process.stdin.isTTY) {
                  noTtyStdin = true
                  abortController.abort()
                  return
                }
                if (!process.stdout.isTTY) return
                stopCapturingEarlyInput()
                rl = createInterface({
                  input: process.stdin,
                  output: process.stdout,
                  prompt: pastePrompt,
                })
                rl.on('SIGINT', () => abortController.abort())
                rl.on('close', () => abortController.abort())
                rl.on('line', line => {
                  const trimmed = line.trim()
                  if (trimmed && submit(trimmed)) return
                  if (trimmed) {
                    process.stdout.write(
                      `That doesn't look like a redirect URL \u2014 paste the full address from your browser's address bar.\n`,
                    )
                  }
                  rl?.prompt()
                })
              },
            },
          ),
        ])
      } catch (err) {
        const cancelled =
          err instanceof AbortError ||
          err instanceof AuthenticationCancelledError ||
          (err instanceof Error && err.name === 'AbortError')
        if (cancelled) {
          if (noTtyStdin) {
            featureBad('cli_mcp_login', 'no_tty_stdin')
            return cliError(
              `Couldn't complete authentication for "${name}": stdin isn't a terminal, so authentication can't be completed here. ` +
                'Re-run in an interactive terminal \u2014 e.g. `ssh -t` \u2014 and paste the redirect URL when prompted.',
            )
          }
          featureSad('cli_mcp_login', 'cancelled')
          process.exit(130)
          return undefined as never
        }
        featureBad('cli_mcp_login', 'oauth_flow_threw')
        return cliError(
          `Couldn't complete authentication for "${name}": ${errorMessage(err)}`,
        )
      } finally {
        clearInterval(keepAlive)
        if (rl) {
          rl.close()
          process.stdout.write('\n')
        }
      }

      await clearMcpAuthCacheEntry(name)
      featureOk('cli_mcp_login')
      return cliOk(
        isMcpServerDisabled(name)
          ? `Authenticated with "${name}", but it's currently disabled. Enable it in /mcp for its tools to load.`
          : `Authenticated with "${name}". Its tools are now available in Claude Code.`,
      )
    }
    default: {
      const _exhaustive: never = classified
      return _exhaustive
    }
  }
}

/**
 * Official 2.1.186 `APf` — `claude mcp logout <name>`.
 */
export async function mcpLogoutHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_logout', {})
  const server = await resolveMcpServerForCliAuth(name, 'cli_mcp_logout')
  const classified = classifyMcpLoginServer(name, server)

  switch (classified.kind) {
    case 'claudeai-proxy': {
      featureSad('cli_mcp_logout', 'claudeai_proxy')
      const connectorsUrl = `${getOauthConfig().CLAUDE_AI_ORIGIN}/customize/connectors`
      return cliOk(
        `"${name}" is a claude.ai connector \u2014 its credentials live on claude.ai, not this machine. ` +
          `Disconnect it at ${createHyperlink(connectorsUrl)}`,
      )
    }
    case 'unsupported-transport':
      featureBad('cli_mcp_logout', 'unsupported_transport')
      return cliError(
        `"${name}" doesn't use OAuth \u2014 there are no stored credentials to clear.`,
      )
    case 'anthropic-hosted': {
      await revokeServerTokens(
        name,
        classified.config as McpSSEServerConfig | McpHTTPServerConfig,
      )
      featureSad('cli_mcp_logout', 'anthropic_hosted')
      return cliOk(
        `Cleared local credentials for "${name}". ${classified.message}`,
      )
    }
    case 'oauth': {
      await revokeServerTokens(name, classified.config)
      featureOk('cli_mcp_logout')
      const loginCmd =
        mcpLoginAuthMethod(classified.config) === null
          ? formatSafeClaudeCommand('mcp login', name)
          : null
      const again = loginCmd ? ` Run \`${loginCmd}\` to authenticate again.` : ''
      return cliOk(`Signed out of "${name}".${again}`)
    }
    default: {
      const _exhaustive: never = classified
      return _exhaustive
    }
  }
}
