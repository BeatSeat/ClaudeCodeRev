import memoize from 'lodash-es/memoize.js'
import { CYBER_RISK_INSTRUCTION } from '../constants/cyberRiskInstruction.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { getAPIProvider } from './model/providers.js'

/**
 * Official 2.1.154 `gM6`. EAP model IDs skip the full-prompt denylist
 * (`c45` false → lean ON).
 */
function isEapModel(model: string): boolean {
  return /-eap($|\[)/i.test(model)
}

/**
 * Official 2.1.154 `UA` as used by `c45`: firstParty | anthropicAws | gateway.
 * Unknown models default to lean ON only on this family (`return !UA()`).
 */
function isFirstPartySimplePromptProvider(): boolean {
  const provider = getAPIProvider() as string
  return (
    provider === 'firstParty' ||
    provider === 'anthropicAws' ||
    provider === 'gateway'
  )
}

/**
 * Official 2.1.154 `d45`. clientDataCache.simple_system_prompt overlay, then
 * Growthbook `tengu_velvet_cascade`.models. Forces lean ON when a key/model
 * substring matches the canonical name. Default-null GB is a no-op.
 */
function simpleSystemPromptOverlay(model: string): boolean {
  const canonical = getCanonicalName(model)
  const cached = getGlobalConfig().clientDataCache?.simple_system_prompt
  if (typeof cached === 'object' && cached !== null) {
    if (
      Object.entries(cached).some(
        ([key, value]) => value === true && canonical.includes(key),
      )
    ) {
      return true
    }
  }
  const gb = getFeatureValue_CACHED_MAY_BE_STALE<{
    models?: unknown
  } | null>('tengu_velvet_cascade', null)
  if (
    typeof gb !== 'object' ||
    gb === null ||
    !('models' in gb) ||
    !Array.isArray(gb.models)
  ) {
    return false
  }
  return gb.models.some(
    entry => typeof entry === 'string' && canonical.includes(entry),
  )
}

/**
 * Official 2.1.154 `c45`. true = keep the full system prompt (lean OFF).
 * 3.x / haiku / sonnet / opus-4-0…4-7 → true. opus-4-8 → false. EAP → false.
 * Else `!UA()` (1P family → false / lean ON).
 */
function shouldKeepFullSystemPrompt(model: string): boolean {
  if (isEapModel(model)) return false
  const canonical = getCanonicalName(model)
  if (
    canonical.includes('claude-3-') ||
    canonical.includes('haiku') ||
    canonical.includes('sonnet') ||
    canonical === 'claude-opus-4-0' ||
    canonical === 'claude-opus-4-1' ||
    canonical === 'claude-opus-4-5' ||
    canonical === 'claude-opus-4-6' ||
    canonical === 'claude-opus-4-7'
  ) {
    return true
  }
  if (canonical === 'claude-opus-4-8') return false
  return !isFirstPartySimplePromptProvider()
}

/**
 * Official 2.1.154 `X3`. Lean / simple system prompt ON?
 * Env override: truthy forces on, defined-falsy forces off. Else
 * `!c45(model) || d45(model)` — opus-4-8 is lean ON by default.
 */
export const isSimpleSystemPrompt = memoize(
  (model: string | undefined): boolean => {
    if (!model) return false
    if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) return true
    if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) {
      return false
    }
    return !shouldKeepFullSystemPrompt(model) || simpleSystemPromptOverlay(model)
  },
)

/**
 * Official 2.1.161 `E1q` — ownership-frame arm (env or `tengu_walnut_prism`).
 */
export const isOwnershipFrameArmed = memoize((): boolean => {
  const fromEnv = isEnvTruthy(process.env.CLAUDE_CODE_OWNERSHIP_FRAME)
  const armed =
    fromEnv ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_walnut_prism', false)
  if (armed) {
    logForDebugging(
      `ownership_frame_arm_active source=${fromEnv ? 'env' : 'growthbook'}`,
    )
  }
  return armed
})

/**
 * Official 2.1.154 `oXz` / 161 `gxA` — lean static prefix when `X3` is true.
 */
export function getLeanHarnessSection(
  outputStyleConfig: { name?: string } | null,
): string {
  const ownership = isOwnershipFrameArmed()
  let identity = ownership
    ? 'You work alongside the user on software engineering tasks and own the outcome of what you take on.'
    : 'You are an interactive agent that helps users with software engineering tasks.'
  if (outputStyleConfig !== null) {
    identity = ownership
      ? 'You work alongside the user and own the outcome of what you take on; your "Output Style" below describes how you should respond to queries.'
      : 'You are an interactive agent that helps users according to your "Output Style" below, which describes how you should respond to user queries.'
  }
  return `
${identity}

${CYBER_RISK_INSTRUCTION}

# Harness
 - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - \`<system-reminder>\` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.
 - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
 - Reference code as \`file_path:line_number\` — it's clickable.`
}

/** Official 2.1.154 `uXz` lean arm. */
export function getLeanAntiVerbositySection(): string {
  return 'Write code that reads like the surrounding code: match its comment density, naming, and idiom.'
}

/** Official 2.1.161 `yxA` (null unless lean; this is the lean body). */
export function getLeanActionCautionSection(): string {
  const lead = isOwnershipFrameArmed()
    ? 'For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking.'
    : 'For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn\'t extend to the next.'
  return `${lead} Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.`
}

/**
 * Official 2.1.154 `N0` lean static prefix: `oXz` + lean `uXz` + `mXz`.
 * Replaces the fat intro/system/doing/actions/tools/tone suite.
 */
export function getLeanSystemPromptSections(
  outputStyleConfig: { name?: string } | null,
): string[] {
  return [
    getLeanHarnessSection(outputStyleConfig),
    getLeanAntiVerbositySection(),
    getLeanActionCautionSection(),
  ]
}
