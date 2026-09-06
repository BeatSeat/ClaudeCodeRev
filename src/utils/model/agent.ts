import { logForDebugging } from '../debug.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES } from './aliases.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import { isModelAllowed, stripTrailing1mSuffix } from './modelAllowlist.js'
import {
  applyOpus1mMergeIfNeeded,
  getCanonicalName,
  getDefaultFableModel,
  getDefaultHaikuModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getRuntimeMainLoopModel,
  isFableAvailable,
  parseUserSpecifiedModel,
} from './model.js'
import { getAPIProvider, isFirstPartyApiFamily } from './providers.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent.
 *
 * For Bedrock, if the parent model uses a cross-region inference prefix (e.g., "eu.", "us."),
 * that prefix is inherited by subagents using alias models (e.g., "sonnet", "haiku", "opus").
 * This ensures subagents use the same region as the parent, which is necessary when
 * IAM permissions are scoped to specific cross-region inference profiles.
 */
function inheritParentModel(
  parentModel: string,
  permissionMode?: PermissionMode,
): string {
  return getRuntimeMainLoopModel({
    permissionMode: permissionMode ?? 'default',
    mainLoopModel: parentModel,
    exceeds200kTokens: false,
  })
}

/** Official 2.1.172 `Tg6`. */
function warnSubagentModelNotAllowed(spec: string): void {
  logForDebugging(
    `Subagent model "${spec}" is not in the availableModels allowlist; inheriting the parent model instead`,
    { level: 'warn' },
  )
}

export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: AgentModelAlias,
  permissionMode?: PermissionMode,
  onModelRestricted?: (requested: string, effective: string) => void,
): string {
  const inherit = () => inheritParentModel(parentModel, permissionMode)

  const fallback = (spec: string, candidate: string = spec) => {
    warnSubagentModelNotAllowed(spec)
    const effective = inherit()
    if (
      stripTrailing1mSuffix(parseUserSpecifiedModel(candidate)).toLowerCase() !==
      stripTrailing1mSuffix(parseUserSpecifiedModel(effective)).toLowerCase()
    ) {
      onModelRestricted?.(spec, effective)
    }
    return effective
  }

  // Official 2.1.172 `He`: env inherit / allowlist before Bedrock prefix.
  const envModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  if (envModel) {
    if (envModel === 'inherit') {
      return inherit()
    }
    const resolved = parseUserSpecifiedModel(envModel)
    if (!isModelAllowed(resolved)) {
      return fallback(envModel)
    }
    return resolved
  }

  // Extract Bedrock region prefix from parent model to inherit for subagents.
  // This ensures subagents use the same cross-region inference profile (e.g., "eu.", "us.")
  // as the parent, which is required when IAM permissions only allow specific regions.
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // Helper to apply parent region prefix for Bedrock models.
  // `originalSpec` is the raw model string before resolution (alias or full ID).
  // If the user explicitly specified a full model ID that already carries its own
  // region prefix (e.g., "eu.anthropic.…"), we preserve it instead of overwriting
  // with the parent's prefix. This prevents silent data-residency violations when
  // an agent config intentionally pins to a different region than the parent.
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && getAPIProvider() === 'bedrock') {
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    if (toolSpecifiedModel === 'inherit') {
      return inherit()
    }
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = applyParentRegionPrefix(
      applyOpus1mMergeIfNeeded(parseUserSpecifiedModel(toolSpecifiedModel)),
      toolSpecifiedModel,
    )
    if (!isModelAllowed(model)) {
      return fallback(toolSpecifiedModel, model)
    }
    return model
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Apply runtime model resolution for inherit to get the effective model
    // This ensures agents using 'inherit' get opusplan→Opus resolution in plan mode
    return inherit()
  }

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = applyParentRegionPrefix(
    applyOpus1mMergeIfNeeded(parseUserSpecifiedModel(agentModelWithExp)),
    agentModelWithExp,
  )
  if (!isModelAllowed(model)) {
    return fallback(agentModelWithExp, model)
  }
  return model
}

/**
 * Check if a bare family alias (opus/sonnet/haiku) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a Vertex user on Opus 4.6 (via /model) who
 * spawns a subagent with `model: opus` should get Opus 4.6, not whatever
 * getDefaultOpusModel() returns for 3P.
 * See https://github.com/anthropics/claude-code/issues/30815.
 *
 * Only bare family aliases match. `opus[1m]`, `best`, `opusplan` fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'fable':
      return canonical.includes('fable')
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
    case 'haiku':
      return canonical.includes('haiku')
    default:
      return false
  }
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  // Official 2.1.172 `ga7`: each family row only if `r3(defaultModel)`.
  const options: AgentModelOption[] = []
  if (
    (isFableAvailable() ||
      !isFirstPartyApiFamily() ||
      getAPIProvider() === 'anthropicAws') &&
    isModelAllowed(getDefaultFableModel())
  ) {
    options.push({
      value: 'fable',
      label: 'Fable',
      description: 'Most capable for your hardest and longest-running tasks',
    })
  }
  if (isModelAllowed(getDefaultSonnetModel())) {
    options.push({
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Efficient for routine tasks',
    })
  }
  if (isModelAllowed(getDefaultOpusModel())) {
    options.push({
      value: 'opus',
      label: 'Opus',
      description: 'Best for everyday, complex tasks',
    })
  }
  if (isModelAllowed(getDefaultHaikuModel())) {
    options.push({
      value: 'haiku',
      label: 'Haiku',
      description: 'Fastest for quick answers',
    })
  }
  options.push({
    value: 'inherit',
    label: 'Inherit from parent',
    description: 'Use the same model as the main conversation',
  })
  return options
}
