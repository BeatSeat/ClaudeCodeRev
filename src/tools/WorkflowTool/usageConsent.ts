import type { ToolUseContext } from '../../Tool.js'
import { logEvent } from '../../services/analytics/index.js'
import { isBgSession } from '../../utils/concurrentSessions.js'
import { logForDebugging } from '../../utils/debug.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import {
  hasSkipWorkflowUsageWarning,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { getAgentId, getTeamName } from '../../utils/teammate.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

/**
 * Official 2.1.153 `zhH` — swarm worker (has team + agent, not team-lead).
 * Lead / standalone sessions still see the usage warning.
 */
function isSwarmWorkerSkippingWorkflowConsent(): boolean {
  const teamName = getTeamName()
  const agentId = getAgentId()
  return !!teamName && !!agentId && agentId !== 'team-lead'
}

/**
 * Official 2.1.153 `BZ_` (`workflowNeedsUsageConsentPrompt`).
 * Skips on non-Workflow, non-interactive, avoid-prompts, `--bg`, swarm
 * worker, effort `=== "ultra"` only, or already-accepted.
 */
export function workflowNeedsUsageConsentPrompt(
  toolName: string,
  context: ToolUseContext,
): boolean {
  if (toolName !== WORKFLOW_TOOL_NAME) {
    return false
  }
  if (context.options.isNonInteractiveSession) {
    return false
  }
  if (context.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts) {
    return false
  }
  if (isBgSession()) {
    return false
  }
  if (isSwarmWorkerSkippingWorkflowConsent()) {
    return false
  }
  // Official `Od(...)==="ultra"` — effort family only.
  if (
    String(
      resolveAppliedEffort(
        context.options.mainLoopModel,
        context.getAppState().effortValue,
      ) ?? '',
    ) === 'ultra'
  ) {
    return false
  }
  return !hasSkipWorkflowUsageWarning()
}

/**
 * Official 2.1.153 `pZ_` (`recordWorkflowUsageConsent`).
 */
export function recordWorkflowUsageConsent(): void {
  if (hasSkipWorkflowUsageWarning()) {
    return
  }
  const { error } = updateSettingsForSource('userSettings', {
    skipWorkflowUsageWarning: true,
  })
  if (error) {
    logForDebugging(
      `Failed to persist skipWorkflowUsageWarning: ${error.message}`,
      { level: 'error' },
    )
    return
  }
  logEvent('tengu_workflow_usage_warning_accepted', {})
}
