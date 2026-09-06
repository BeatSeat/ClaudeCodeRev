import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

// Memoized: 150+ callers, many on hot paths. Keyed off CLAUDE_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * Official 2.1.144 `Ia`. Secure-storage dir: CLAUDE_SECURESTORAGE_CONFIG_DIR
 * (empty string → ~/.claude) else CLAUDE_CONFIG_DIR / ~/.claude.
 */
export function getSecureStorageConfigDir(): string {
  const override = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (override !== undefined) {
    return (override || join(homedir(), '.claude')).normalize('NFC')
  }
  return getClaudeConfigHomeDir()
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 *
 * Official 2.1.169 `bF$`/`i5`: the argv check stops at `--` so a bare flag
 * typed as part of the prompt passthrough doesn't enable the mode.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    hasCliFlagBeforeDoubleDash('--bare')
  )
}

/**
 * Official 2.1.169 `bF$`. True when `flag` appears in process.argv before a
 * `--` separator (everything after `--` is the prompt passthrough, not
 * flags).
 */
export function hasCliFlagBeforeDoubleDash(flag: string): boolean {
  const doubleDashIndex = process.argv.indexOf('--')
  const argv =
    doubleDashIndex === -1 ? process.argv : process.argv.slice(0, doubleDashIndex)
  return argv.includes(flag)
}

/**
 * --safe-mode / CLAUDE_CODE_SAFE_MODE — start with all customizations
 * (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and
 * agents, output styles, workflows, custom themes, keybindings, and more)
 * disabled for troubleshooting a broken configuration. Admin-managed
 * (policy) settings still apply; auth, model selection, built-in tools, and
 * permissions work normally.
 *
 * Checks argv directly (like isBareMode) because gates run before main.tsx's
 * action handler sets CLAUDE_CODE_SAFE_MODE=1. Official 2.1.169 `C9`.
 */
export function isSafeMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SAFE_MODE) ||
    hasCliFlagBeforeDoubleDash('--safe-mode')
  )
}

/**
 * How to re-enable customizations next session, depending on how safe mode
 * was entered (CLI flag vs env var). Official 2.1.169 `UJ`.
 */
export function getSafeModeExitHint(): string {
  return hasCliFlagBeforeDoubleDash('--safe-mode')
    ? 'restart without --safe-mode'
    : 'unset CLAUDE_CODE_SAFE_MODE'
}

/**
 * Same for bare mode. Official 2.1.169 `yGq`.
 */
export function getBareModeExitHint(): string {
  return hasCliFlagBeforeDoubleDash('--bare')
    ? 'restart without --bare'
    : 'unset CLAUDE_CODE_SIMPLE'
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether Claude Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-fable-5', 'VERTEX_REGION_CLAUDE_FABLE_5'],
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-8', 'VERTEX_REGION_CLAUDE_4_8_OPUS'],
  ['claude-opus-4-7', 'VERTEX_REGION_CLAUDE_4_7_OPUS'],
  ['claude-opus-4-6', 'VERTEX_REGION_CLAUDE_4_6_OPUS'],
  ['claude-opus-4-5', 'VERTEX_REGION_CLAUDE_4_5_OPUS'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
