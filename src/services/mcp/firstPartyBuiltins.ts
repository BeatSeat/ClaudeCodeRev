import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isAnthropicDesignMcpUrl } from './officialRegistry.js'
import type { ScopedMcpServerConfig } from './types.js'

/** Official 2.1.179 `gi_`. */
export const CLAUDE_DESIGN_MCP_NAME = 'claude_design'

/** Official 2.1.179 `di_`. */
export const CLAUDE_DESIGN_MCP_URL =
  'https://api.anthropic.com/v1/design/mcp'

/** Official 2.1.179 `li_`. */
export const DESIGN_MCP_GROWTHBOOK_FLAG = 'tengu_omelette_whisk'

type FeatureFlagGetter = <T>(feature: string, defaultValue: T) => T

/** Official 2.1.179 `VE6` — injected by GrowthBook init (`Vz7(j$)`). */
let featureFlagGetter: FeatureFlagGetter | null = null

/**
 * Official 2.1.179 `Vz7` — swap the GB getter (tests / growthbook module init).
 */
export function setDesignMcpFeatureFlagGetter(
  getter: FeatureFlagGetter | null,
): FeatureFlagGetter | null {
  const prev = featureFlagGetter
  featureFlagGetter = getter
  return prev
}

/** Official 2.1.179 `ci_`. */
export function getClaudeDesignMcpUrl(): string {
  return CLAUDE_DESIGN_MCP_URL
}

/**
 * Official 2.1.179 `ni_` — env `CLAUDE_CODE_ENABLE_DESIGN_MCP` (triBool) else GB.
 */
export function isDesignMcpEnabled(): boolean {
  const env = process.env.CLAUDE_CODE_ENABLE_DESIGN_MCP
  if (env !== undefined) {
    return isEnvTruthy(env)
  }
  return featureFlagGetter?.(DESIGN_MCP_GROWTHBOOK_FLAG, false) ?? false
}

/**
 * Official 2.1.179 `Tz7` — first-party builtin MCP servers (gated on firstParty).
 * Throws if a builtin URL is not on the design allowlist (`hn`).
 */
export function getFirstPartyBuiltinMcpServers(): Record<
  string,
  ScopedMcpServerConfig
> {
  if (getAPIProvider() !== 'firstParty') {
    return {}
  }
  const servers: Record<string, ScopedMcpServerConfig> = {}
  if (isDesignMcpEnabled()) {
    servers[CLAUDE_DESIGN_MCP_NAME] = {
      type: 'http',
      url: getClaudeDesignMcpUrl(),
      scope: 'dynamic',
    }
  }
  for (const server of Object.values(servers)) {
    if ('url' in server && !isAnthropicDesignMcpUrl(server.url)) {
      throw new Error(
        'A built-in first-party MCP server URL is not on the first-party allowlist (FIRST_PARTY_MCP_PATH_PREFIXES / isFirstPartyAnthropicHost) — login-OAT auto-attach and bare-name rendering would not fire. Update firstPartyBuiltins.ts or authState.ts so they agree.',
      )
    }
  }
  return servers
}
