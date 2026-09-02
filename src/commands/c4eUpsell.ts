// Official 2.1.160 G11 — `tengu_c4e_slash_upsell{,_shown}`.
//
// C4E (Claude for Enterprise) slash-command upsell: wraps the remote/web
// commands (ultraplan, ultrareview, teleport, remote-control, schedule,
// autofix-pr) as hidden stand-in commands that only surface for 1P API-key
// customers. When such a user invokes one, it does NOT run the real command —
// it emits `tengu_c4e_slash_upsell_shown` and returns an upsell pointing them
// to migrate from API-key access to Claude for Enterprise.
//
// Bundle mapping (cli.js 2.1.160):
//   r0A  -> isC4eUpsellEligible()          (f2H() && !x6() && gate)
//   f2H  -> isFirstPartyApiKeyCustomer()   (C5() && MwH())
//   o0A  -> c4eUpsellMessage()
//   uq$  -> createC4eUpsellCommand()
//   a0A  -> hasClaudeAiInferenceToken()    (Gq())
//   Et4  -> C4E_UPSELL_COMMANDS
//   W$("tengu_c4e_slash_upsell", !1) -> getFeatureValue_CACHED_MAY_BE_STALE
//   d("tengu_c4e_slash_upsell_shown", {command}) -> logEvent
import type { Command } from '../types/command.js'
import { logEvent } from '../services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isFirstPartyAnthropicBaseUrl, getAPIProvider } from '../utils/model/providers.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'
import { getIsInteractive } from '../bootstrap/state.js'

/** Bundle `Gq` — session holds a claude.ai OAuth token with the inference scope. */
export function hasClaudeAiInferenceToken(): boolean {
  return getClaudeAIOAuthTokens()?.scopes?.includes('user:inference') ?? false
}

/**
 * Bundle `f2H` (`C5() && MwH()`) — a direct first-party API-key customer:
 * api.anthropic.com base URL, first-party provider, and NOT a claude.ai subscriber.
 */
function isFirstPartyApiKeyCustomer(): boolean {
  if (!isFirstPartyAnthropicBaseUrl()) return false
  return getAPIProvider() === 'firstParty' && !hasClaudeAiInferenceToken()
}

/**
 * Bundle `r0A` — the upsell is offered when the user is a 1P API-key customer,
 * in an interactive session, and the `tengu_c4e_slash_upsell` gate is on
 * (default off).
 */
function isC4eUpsellEligible(): boolean {
  return (
    isFirstPartyApiKeyCustomer() &&
    getIsInteractive() &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_c4e_slash_upsell', false)
  )
}

/** Bundle `o0A` — the upsell body text. */
function c4eUpsellMessage(commandName: string): string {
  return `/${commandName} is available with Claude for Enterprise — ask your admin about migrating from API-key access.`
}

/**
 * Bundle `uq$` — build a hidden C4E stand-in for a remote/web command.
 * `isEnabled` mirrors the bundle: only active for non-subscriber 1P API-key
 * customers (see `isC4eUpsellEligible`).
 */
function createC4eUpsellCommand(spec: {
  name: string
  aliases?: string[]
  description: string
}): Command {
  return {
    type: 'local',
    name: spec.name,
    aliases: spec.aliases,
    description: `${spec.description} — available with Claude for Enterprise`,
    isEnabled: () => !hasClaudeAiInferenceToken() && isC4eUpsellEligible(),
    isHidden: true,
    supportsNonInteractive: false,
    load: () =>
      Promise.resolve({
        call: async (): Promise<{ type: 'text'; value: string }> => {
          logEvent('tengu_c4e_slash_upsell_shown', { command: spec.name })
          return { type: 'text', value: c4eUpsellMessage(spec.name) }
        },
      }),
  }
}

/**
 * Bundle `Et4` — the set of remote/web commands wrapped as C4E upsell stand-ins.
 * Spread into the command list in commands.ts.
 */
export const C4E_UPSELL_COMMANDS: Command[] = [
  createC4eUpsellCommand({
    name: 'ultraplan',
    description: 'Claude Code on the web drafts a plan you can edit and approve',
  }),
  createC4eUpsellCommand({
    name: 'ultrareview',
    description: 'Find and verify bugs in your branch using Claude Code on the web',
  }),
  createC4eUpsellCommand({
    name: 'teleport',
    aliases: ['tp'],
    description: 'Resume a Claude Code session from claude.ai',
  }),
  createC4eUpsellCommand({
    name: 'remote-control',
    aliases: ['rc'],
    description: 'Control this session from your phone or claude.ai/code',
  }),
  createC4eUpsellCommand({
    name: 'schedule',
    aliases: ['routines'],
    description: 'Create and manage scheduled remote Claude Code agents',
  }),
  createC4eUpsellCommand({
    name: 'autofix-pr',
    description: 'Monitor and autofix any issues with the current PR',
  }),
]
