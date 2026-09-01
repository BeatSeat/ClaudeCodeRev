import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getSkillOverride } from '../../utils/settings/skillOverrides.js'

// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4

// Official 2.1.105 `X7z` — raised from 250.
export const MAX_LISTING_DESC_CHARS = 1536

function getListingMaxDescChars(): number {
  return getInitialSettings().skillListingMaxDescChars ?? MAX_LISTING_DESC_CHARS
}

function getListingBudgetFraction(): number {
  return (
    getInitialSettings().skillListingBudgetFraction ??
    SKILL_BUDGET_CONTEXT_PERCENT
  )
}

let didWarnTruncatedSkillDesc = false

export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  const fraction = getListingBudgetFraction()
  if (contextWindowTokens) {
    return Math.max(
      1,
      Math.floor(contextWindowTokens * CHARS_PER_TOKEN * fraction),
    )
  }
  return Math.max(
    1,
    Math.floor(DEFAULT_CHAR_BUDGET * (fraction / SKILL_BUDGET_CONTEXT_PERCENT)),
  )
}

function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  const cap = getListingMaxDescChars()
  if (desc.length > cap) {
    if (!didWarnTruncatedSkillDesc) {
      didWarnTruncatedSkillDesc = true
      logForDebugging(
        `Skill descriptions longer than ${cap} characters are truncated in the listing sent to Claude. Raise skillListingMaxDescChars in settings.json to opt in to higher per-turn context cost.`,
        { level: 'warn' },
      )
    }
    return desc.slice(0, cap - 1) + '\u2026'
  }
  return desc
}

function formatCommandDescription(cmd: Command): string {
  // Debug: log if userFacingName differs from cmd.name for plugin skills
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

const MIN_DESC_LENGTH = 20

export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
  /**
   * Official 2.1.129: when supplied, the budget is spent on the
   * highest-scoring skills instead of trimming every description to the same
   * length. Skills that don't fit fall back to name-only.
   */
  getPriorityScore?: (cmd: Command) => number,
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // Try full descriptions first
  const nameOnlyIndices = new Set<number>()
  const fullEntries = commands.map((cmd, i) => {
    if (getSkillOverride(cmd) === 'name-only') {
      nameOnlyIndices.add(i)
      return { cmd, full: `- ${cmd.name}` }
    }
    return { cmd, full: formatCommandDescription(cmd) }
  })
  // join('\n') produces N-1 newlines for N entries
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // Partition into never-truncated (bundled + name-only) and rest
  const bundledIndices = new Set<number>(nameOnlyIndices)
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else if (!nameOnlyIndices.has(i)) {
      restCommands.push(cmd)
    }
  }

  // Compute space used by bundled skills (full descriptions, always preserved)
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  )
  const remainingBudget = budget - bundledChars

  // Calculate max description length for non-bundled commands
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n')
  }

  if (getPriorityScore) {
    const candidates = commands
      .map((_cmd, i) => i)
      .filter(i => !bundledIndices.has(i))
    const nameCost = (i: number): number => stringWidth(commands[i]!.name) + 2
    const fullCost = (i: number): number => stringWidth(fullEntries[i]!.full)
    // Baseline: everything not preserved collapses to name-only. Whatever the
    // budget has left over buys back full descriptions, best score first.
    const baseline =
      commands.reduce(
        (sum, _cmd, i) => sum + (bundledIndices.has(i) ? fullCost(i) : nameCost(i)),
        0,
      ) +
      (commands.length - 1)
    let slack = budget - baseline
    const upgraded = new Set<number>()
    const byScore = candidates
      .slice()
      .sort((a, b) => getPriorityScore(commands[b]!) - getPriorityScore(commands[a]!))
    for (const i of byScore) {
      const extra = fullCost(i) - nameCost(i)
      if (extra <= slack) {
        upgraded.add(i)
        slack -= extra
      }
    }
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) || upgraded.has(i)
          ? fullEntries[i]!.full
          : `- ${cmd.name}`,
      )
      .join('\n')
  }

  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1)
  const availableForDescs = remainingBudget - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: non-bundled go names-only, bundled keep descriptions
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: fullTotal,
        truncation_mode:
          'names_only' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_desc_length: maxDescLen,
        bundled_count: bundledIndices.size,
        bundled_chars: bundledChars,
      })
    }
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n')
  }

  // Truncate non-bundled descriptions to fit within budget
  const truncatedCount = count(
    restCommands,
    cmd => stringWidth(getCommandDescription(cmd)) > maxDescLen,
  )
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'description_trimmed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      max_desc_length: maxDescLen,
      truncated_count: truncatedCount,
      // Count of bundled skills included in this prompt (excludes skills with disableModelInvocation)
      bundled_count: bundledIndices.size,
      bundled_chars: bundledChars,
    })
  }
  return commands
    .map((cmd, i) => {
      // Bundled skills always get full descriptions
      if (bundledIndices.has(i)) return fullEntries[i]!.full
      const description = getCommandDescription(cmd)
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
    })
    .join('\n')
}

export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>", they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Set \`skill\` to the exact name of an available skill (no leading slash). For plugin-namespaced skills use the fully qualified \`plugin:skill\` form.
- Set \`args\` to pass optional arguments.

Important:
- Available skills are listed in system-reminder messages in the conversation
- Only invoke a skill that appears in that list, or one the user explicitly typed as \`/<name>\` in their message. Never guess or invent a skill name from training data; otherwise do not call this tool
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})

export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// Returns the commands included in the SkillTool prompt.
// All commands are always included (descriptions may be truncated to fit budget).
// Used by analyzeContext to count skill tokens.
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    logError(toError(error))

    // Return zeros rather than throwing - let caller decide how to handle
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
