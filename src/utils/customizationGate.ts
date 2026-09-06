import { getAdditionalDirectoriesForClaudeMd } from '../bootstrap/state.js'
import { isBareMode, isEnvTruthy, isSafeMode } from './envUtils.js'

/**
 * Official 2.1.169 `K1`/`cS_`/`lS_` — the unified customization gate.
 *
 * Every user-customizable surface (CLAUDE.md, skills, plugins, hooks, MCP,
 * agents, themes, keybindings, ...) is checked against two tables:
 *
 *  - BARE_MODE_DISABLED_SURFACES (`cS_`): value true = surface is skipped in
 *    bare mode, unless the call site passes explicitlyRequested ("--bare
 *    means skip what I didn't ask for, not ignore what I asked for").
 *  - SAFE_MODE_EXEMPT_SURFACES (`lS_`): value true = surface still loads in
 *    safe mode (hooks, statusLine, fileSuggestion); false = disabled by
 *    safe mode. Admin-managed (policy) sources are unaffected — those keep
 *    loading per their own checks.
 */

const GATE_SURFACES = [
  'claudeMd',
  'skills',
  'workflows',
  'plugins',
  'pluginMonitors',
  'themes',
  'hooks',
  'statusLine',
  'fileSuggestion',
  'mcpAutoDiscovered',
  'mcpClaudeAi',
  'mcpAgentFrontmatter',
  'agents',
  'outputStyles',
  'lspServers',
  'keybindings',
] as const

export type CustomizationGateSurface = (typeof GATE_SURFACES)[number]

const BARE_MODE_DISABLED_SURFACES: Record<CustomizationGateSurface, boolean> =
  {
    claudeMd: true,
    skills: true,
    workflows: false,
    plugins: true,
    pluginMonitors: false,
    themes: false,
    hooks: true,
    statusLine: false,
    fileSuggestion: false,
    mcpAutoDiscovered: false,
    mcpClaudeAi: false,
    mcpAgentFrontmatter: true,
    agents: true,
    outputStyles: false,
    lspServers: true,
    keybindings: false,
  }

const SAFE_MODE_EXEMPT_SURFACES: Record<CustomizationGateSurface, boolean> = {
  claudeMd: false,
  skills: false,
  workflows: false,
  plugins: false,
  pluginMonitors: false,
  themes: false,
  hooks: true,
  statusLine: true,
  fileSuggestion: true,
  mcpAutoDiscovered: false,
  mcpClaudeAi: false,
  mcpAgentFrontmatter: false,
  agents: false,
  outputStyles: false,
  lspServers: false,
  keybindings: false,
}

/**
 * True when the surface's user-provided customizations are disabled this
 * session (safe mode, or bare mode without an explicit request).
 *
 * Official 2.1.169 `K1(H, $)`:
 *   if (isSafeMode() && !SAFE_MODE_EXEMPT_SURFACES[H]) return true
 *   if (isBareMode() && !$?.explicitlyRequested) return BARE_MODE_DISABLED_SURFACES[H]
 *   return false
 */
export function isCustomizationDisabled(
  surface: CustomizationGateSurface,
  opts?: { explicitlyRequested?: boolean },
): boolean {
  if (isSafeMode() && !SAFE_MODE_EXEMPT_SURFACES[surface]) {
    return true
  }
  if (isBareMode() && !opts?.explicitlyRequested) {
    return BARE_MODE_DISABLED_SURFACES[surface]
  }
  return false
}

/**
 * Official 2.1.169 `T6H` — the shared CLAUDE.md gate. Hard-off env var wins;
 * otherwise the customization gate with explicit --add-dir counts as an
 * explicit request (bare mode honors dirs it was asked to load).
 */
export function shouldDisableClaudeMds(): boolean {
  return Boolean(
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      isCustomizationDisabled('claudeMd', {
        explicitlyRequested:
          getAdditionalDirectoriesForClaudeMd().length > 0,
      }),
  )
}
