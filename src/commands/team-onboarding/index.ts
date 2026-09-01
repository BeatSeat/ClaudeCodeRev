import type { Command } from '../../commands.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  DEFAULT_TEAM_ONBOARDING_GUIDE,
  DEFAULT_TEAM_ONBOARDING_PROMPT,
} from './templates.js'
import { collectTeamOnboardingUsage } from './usageScan.js'

const DEFAULT_WINDOW_DAYS = 30

type FlintHarborPrompt = {
  prompt?: string
  guideTemplate?: string
  windowDays?: number
}

function clampWindowDays(value: number): number {
  return Math.min(Math.max(Math.floor(value), 1), 365)
}

const teamOnboarding = {
  type: 'prompt',
  name: 'team-onboarding',
  description:
    'Help teammates ramp on Claude Code with a guide from your usage',
  allowedTools: ['Edit(ONBOARDING.md)', 'Bash(ls:*)'],
  contentLength: 0,
  isEnabled: () =>
    isEnvTruthy(process.env.CLAUDE_CODE_TEAM_ONBOARDING) ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_flint_harbor', false),
  isHidden: false,
  progressMessage: 'scanning usage data',
  userFacingName: () => 'team-onboarding',
  source: 'builtin',
  async getPromptForCommand() {
    const config = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_flint_harbor_prompt',
      {},
    ) as FlintHarborPrompt
    const prompt =
      typeof config.prompt === 'string'
        ? config.prompt
        : DEFAULT_TEAM_ONBOARDING_PROMPT
    const guideTemplate =
      typeof config.guideTemplate === 'string'
        ? config.guideTemplate
        : DEFAULT_TEAM_ONBOARDING_GUIDE
    const windowDays =
      typeof config.windowDays === 'number'
        ? clampWindowDays(config.windowDays)
        : DEFAULT_WINDOW_DAYS
    logEvent('tengu_team_onboarding_invoked', { window_days: windowDays })
    const { usageData, sessionCount, slashCommandCount, mcpServerCount } =
      await collectTeamOnboardingUsage(windowDays)
    const text = prompt
      .replaceAll('{{WINDOW_DAYS}}', String(windowDays))
      .replaceAll('{{GUIDE_TEMPLATE}}', guideTemplate)
      .replaceAll('{{USAGE_DATA}}', usageData)
    logEvent('tengu_team_onboarding_generated', {
      session_count: sessionCount,
      slash_command_count: slashCommandCount,
      mcp_server_count: mcpServerCount,
      window_days: windowDays,
    })
    return [{ type: 'text' as const, text }]
  },
} satisfies Command

export default teamOnboarding
