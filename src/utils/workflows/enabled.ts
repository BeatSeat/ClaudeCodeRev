import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { getSubscriptionType } from '../auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getInitialSettings } from '../settings/settings.js'

export type WorkflowsAvailability = {
  available: boolean
  defaultOn: boolean
}

/**
 * Official 2.1.153 `b78` — env or settings kill-switch.
 */
export function areWorkflowsDisabledByKillSwitch(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) ||
    getInitialSettings()?.disableWorkflows === true
  )
}

/**
 * Official 2.1.153 `NJ5` — user/merged `enableWorkflows` (unset = plan default).
 */
export function getEnableWorkflowsSetting(): boolean | undefined {
  return getInitialSettings()?.enableWorkflows
}

/**
 * Official 2.1.153 `EJ5` — env + GrowthBook + plan default.
 */
export function computeWorkflowsAvailability(): WorkflowsAvailability {
  if (isEnvTruthy(process.env.CLAUDE_CODE_WORKFLOWS)) {
    const enabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_workflows_enabled',
      true,
    )
    return { available: enabled, defaultOn: enabled }
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_WORKFLOWS)) {
    return { available: false, defaultOn: false }
  }
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_workflows_enabled', false)) {
    return { available: false, defaultOn: false }
  }
  return { available: true, defaultOn: getSubscriptionType() !== 'pro' }
}

/** Official 2.1.153 `x78` — memo for `zL6`. */
let workflowsAvailability: WorkflowsAvailability | undefined

/**
 * Official 2.1.153 `zL6` — cached `EJ5`.
 */
export function getWorkflowsAvailability(): WorkflowsAvailability {
  if (workflowsAvailability !== undefined) {
    return workflowsAvailability
  }
  workflowsAvailability = computeWorkflowsAvailability()
  return workflowsAvailability
}

/**
 * Official 2.1.153 `_L6`.
 */
export function getWorkflowsDefaultOn(): boolean {
  return getWorkflowsAvailability().defaultOn
}

/**
 * Official 2.1.153 `EH7` — Config toggle may show (`oH` also checks setting source).
 */
export function isWorkflowsAvailable(): boolean {
  return (
    isPolicyAllowed('allow_workflows') &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) &&
    getWorkflowsAvailability().available
  )
}

/**
 * Official 2.1.153 `xN` — runtime gate for /workflows and the Config value.
 */
/** Official 2.1.157 `x48`. */
export function isWorkflowKeywordTriggerEnabled(): boolean {
  return getInitialSettings()?.workflowKeywordTriggerEnabled ?? true
}

export function isWorkflowsEnabled(): boolean {
  if (areWorkflowsDisabledByKillSwitch()) {
    return false
  }
  if (!isPolicyAllowed('allow_workflows')) {
    return false
  }
  const { available, defaultOn } = getWorkflowsAvailability()
  if (!available) {
    return false
  }
  return getEnableWorkflowsSetting() ?? defaultOn
}
