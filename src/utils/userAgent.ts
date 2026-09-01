/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${MACRO.VERSION}`
}

/** Official 2.1.120 Oj8 — `claude-code/<ver>/<role>` for gh AI_AGENT attribution. */
export function formatAiAgentValue(role: 'harness' | 'agent'): string {
  return `${getClaudeCodeUserAgent()}/${role}`
}

/**
 * Official 2.1.120 lL$. Set process.env.AI_AGENT so subprocesses (gh)
 * can attribute traffic to Claude Code. Does not overwrite a non-claude-code
 * value the user already set.
 */
export function applyAiAgentEnv(): void {
  if (
    !process.env.AI_AGENT ||
    process.env.AI_AGENT.startsWith('claude-code/')
  ) {
    process.env.AI_AGENT = formatAiAgentValue('harness')
  }
}

/** Alias used by cli.tsx / main.tsx call sites. */
export const ensureAiAgentHarnessEnv = applyAiAgentEnv
