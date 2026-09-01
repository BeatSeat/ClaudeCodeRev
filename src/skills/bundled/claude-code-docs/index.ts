import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import type { ToolUseContext } from '../../../Tool.js'
import { getAPIProvider } from '../../../utils/model/providers.js'
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js'
import {
  getStoredChangelog,
  parseChangelog,
} from '../../../utils/releaseNotes.js'
import { order as semverOrder } from '../../../utils/semver.js'
import { registerBundledSkill } from '../../bundledSkills.js'
import {
  CLAUDE_CODE_SKILL_LIVE_SOURCES,
  CLAUDE_CODE_SKILL_RECENT_CHANGES,
  CLAUDE_CODE_SKILL_SYSTEM_PROMPT,
} from './references.js'

/**
 * Official 2.1.154 `zRz` (`registerClaudeCodeSkill`). The `claude-code-docs`
 * skill answers questions about Claude Code itself, verifying answers against
 * the running build. Gated by `tengu_birch_kettle` (default off).
 */

// Official `rj9`.
const CLAUDE_CODE_SKILL_NAME = 'claude-code-docs'

// Official `oj9` (=`qRz` + TRIGGER + SKIP).
const CLAUDE_CODE_SKILL_DESCRIPTION =
  'Answer questions about Claude Code itself: commands, flags, settings, hooks, skills, MCP servers, subagents, IDE integrations, sandboxing, deployment. Verifies against the running build before recommending any command, flag, or setting.\n' +
  'TRIGGER when: user asks how Claude Code works ("Can Claude\u2026", "Does Claude\u2026", "How do I\u2026", "Is there a way to\u2026"); user asks about a slash command, CLI flag, settings key, hook, skill, MCP server, subagent, keybinding, or .claude/ directory; user wants to configure, customize, or troubleshoot Claude Code; YOU are about to recommend a Claude Code slash command, flag, or setting and have not verified it exists in this build.\n' +
  'SKIP: questions about building applications with the Claude API or Anthropic SDK (use /claude-api), general programming questions, questions about the user\u2019s own codebase.'

// Official `nj9`: reference docs extracted to disk on first invocation so the
// model can Read/Grep them on demand (same contract as disk-based skills).
const CLAUDE_CODE_SKILL_FILES: Record<string, string> = {
  'references/live-sources.md': CLAUDE_CODE_SKILL_LIVE_SOURCES,
  'references/recent-changes.md': CLAUDE_CODE_SKILL_RECENT_CHANGES,
}

/**
 * Official 2.1.154 `KRz`: build the "Current Build" snapshot from the running
 * process — available commands, custom skills, custom agents, configured MCP
 * servers, configured settings keys, recent releases, and (when not on the
 * first-party API) a provider caveat.
 */
async function buildCurrentBuild(context: ToolUseContext): Promise<string> {
  const sections: string[] = []
  const { commands, agentDefinitions, mcpClients } = context.options

  const visibleCommands = commands.filter(cmd => !cmd.isHidden)
  // A prompt command counts as a "custom skill" unless it is builtin/bundled.
  const isBuiltinPrompt = (cmd: (typeof commands)[number]) =>
    cmd.type !== 'prompt' ||
    cmd.source === 'builtin' ||
    cmd.source === 'bundled'
  const builtinCommands = visibleCommands.filter(cmd => isBuiltinPrompt(cmd))
  if (builtinCommands.length > 0) {
    const lines = builtinCommands
      .map(cmd => {
        const aliases = cmd.aliases?.length
          ? ` (aliases: ${cmd.aliases.map(a => `/${a}`).join(', ')})`
          : ''
        return `- /${cmd.name}${aliases}: ${cmd.description}`
      })
      .sort()
    sections.push(
      `**Available commands (${builtinCommands.length} in this build):**\n${lines.join('\n')}`,
    )
  }
  const customSkills = visibleCommands.filter(cmd => !isBuiltinPrompt(cmd))
  if (customSkills.length > 0) {
    const lines = customSkills
      .map(cmd => `- /${cmd.name}: ${cmd.description}`)
      .sort()
    sections.push(`**Custom skills configured:**\n${lines.join('\n')}`)
  }
  const customAgents = agentDefinitions.activeAgents.filter(
    agent => agent.source !== 'built-in',
  )
  if (customAgents.length > 0) {
    const lines = customAgents
      .map(agent => `- ${agent.agentType}: ${agent.whenToUse}`)
      .sort()
    sections.push(`**Custom agents configured:**\n${lines.join('\n')}`)
  }
  if (mcpClients && mcpClients.length > 0) {
    const lines = mcpClients.map(client => `- ${client.name}`).sort()
    sections.push(`**Configured MCP servers:**\n${lines.join('\n')}`)
  }
  const settingsKeys = Object.keys(getSettings_DEPRECATED()).sort()
  if (settingsKeys.length > 0) {
    sections.push(
      `**Settings keys configured (values omitted):** ${settingsKeys.join(
        ', ',
      )}. To see values, the user can run \`claude config list\` or open \`~/.claude/settings.json\`.`,
    )
  }

  // Recent releases at-or-below the running version, newest 10, newest first.
  const currentVersion = typeof MACRO !== 'undefined' ? MACRO.VERSION : '0.0.0'
  try {
    const parsed = parseChangelog(await getStoredChangelog())
    const entries = Object.entries(parsed)
      .map(([version, notes]) => [version, notes.filter(Boolean)] as const)
      .filter(([, notes]) => notes.length > 0)
      .sort(([a], [b]) => (semverOrder(a, b) === -1 ? -1 : 1))
    const atOrBelowCurrent = entries.filter(
      ([version]) => semverOrder(version, currentVersion) <= 0,
    )
    const recent = atOrBelowCurrent.slice(-10).reverse()
    if (recent.length > 0) {
      const blocks = recent
        .map(
          ([version, notes]) =>
            `### ${version}\n` + notes.map(note => `- ${note}`).join('\n'),
        )
        .join('\n\n')
      sections.push(
        `**Recent releases (you are running v${currentVersion}):**\n${blocks}`,
      )
    }
  } catch {
    // No changelog yet — skip the section (matches the bundle's empty catch).
  }

  if (getAPIProvider() !== 'firstParty') {
    sections.push(
      "**Provider context:** This session is not using Anthropic's first-party API. WebSearch may be unavailable, `/feedback` is unavailable, and some features behave differently \u2014 check the docs page for the user's specific provider. Direct issues to https://github.com/anthropics/claude-code/issues.",
    )
  }

  return sections.join('\n\n')
}

/**
 * Official 2.1.154 `_Rz`: assemble the final prompt = [system prompt, Current
 * Build snapshot, user request].
 */
function buildSkillPrompt(
  args: string,
  context: ToolUseContext,
  currentBuild: string,
): string {
  const parts: string[] = [CLAUDE_CODE_SKILL_SYSTEM_PROMPT]
  if (currentBuild) {
    parts.push(
      `---\n\n# Current Build\n\nGenerated from the running Claude Code binary at invocation time. This is ground truth \u2014 it overrides your training data and any documentation when they disagree about what exists in this build.\n\n${currentBuild}`,
    )
  }
  if (args.trim()) {
    parts.push(`---\n\n## User Request\n\n${args}`)
  }
  return parts.join('\n\n')
}

export function registerClaudeCodeSkill(): void {
  registerBundledSkill({
    name: CLAUDE_CODE_SKILL_NAME,
    description: CLAUDE_CODE_SKILL_DESCRIPTION,
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    argumentHint: '[question]',
    userInvocable: true,
    files: CLAUDE_CODE_SKILL_FILES,
    isEnabled: () => getFeatureValue_CACHED_MAY_BE_STALE('tengu_birch_kettle', false),
    async getPromptForCommand(args, context) {
      logEvent('tengu_claude_code_skill_loaded', {
        has_args: args.trim().length > 0,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      const currentBuild = await buildCurrentBuild(context)
      return [
        {
          type: 'text',
          text: buildSkillPrompt(args, context, currentBuild),
        },
      ]
    },
  })
}
