import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

export type UltraplanPromptIdentifier =
  | 'simple_plan'
  | 'visual_plan'
  | 'three_subagents_with_critique'

export type UltraplanPromptVariant = {
  timeEstimate: string
  dialogBody: string
  dialogPipeline: string
  usageBlurb: string[]
}

const SIMPLE_PLAN: UltraplanPromptVariant = {
  timeEstimate: 'a few minutes',
  dialogBody:
    "Interactive planning on the web where you can edit and leave targeted comments on Claude's plan.",
  dialogPipeline: 'Plan → Edit → Execute',
  usageBlurb: [
    'Remote plan mode with rich web editing experience.',
    'Runs in Claude Code on the web. When the plan is ready,',
    'you can execute it in the web session or send it back here.',
    'You can continue to work while the plan is generated remotely.',
  ],
}

const VARIANTS: Record<UltraplanPromptIdentifier, UltraplanPromptVariant> = {
  simple_plan: SIMPLE_PLAN,
  visual_plan: SIMPLE_PLAN,
  three_subagents_with_critique: {
    timeEstimate: '~10–30 min',
    dialogBody:
      "Interactive planning on the web where you can edit and leave targeted comments on Claude's plan.",
    dialogPipeline: 'Scope → Critique → Edit → Execute',
    usageBlurb: [
      'Advanced multi-agent plan mode.',
      'Runs in Claude Code on the web. When the plan is ready,',
      'you can execute it in the web session or send it back here.',
      'You can continue to work while the plan is generated remotely.',
    ],
  },
}

function isPromptIdentifier(value: string): value is UltraplanPromptIdentifier {
  return value in VARIANTS
}

/** Official 2.1.98 Gn8. */
export function getUltraplanPromptIdentifier(): UltraplanPromptIdentifier {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_ultraplan_prompt_identifier',
    'simple_plan',
  )
  return isPromptIdentifier(raw) ? raw : 'simple_plan'
}

/** Official 2.1.98 fn8. */
export function getUltraplanPromptVariant(
  identifier: UltraplanPromptIdentifier = getUltraplanPromptIdentifier(),
): UltraplanPromptVariant {
  return VARIANTS[identifier]
}
