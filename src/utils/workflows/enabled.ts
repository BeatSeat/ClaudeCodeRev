import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../envUtils.js'
import { getInitialSettings } from '../settings/settings.js'

/**
 * Official 2.1.152 `pK8` — env or settings kill-switch.
 */
export function areWorkflowsDisabledByKillSwitch(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) ||
    getInitialSettings()?.disableWorkflows === true
  )
}

/** Official 2.1.152 `Qj$` — memo for `CN`. */
let workflowsEnabledMemo: boolean | undefined

/**
 * Official 2.1.152 `CN` — kill-switch + `CLAUDE_CODE_WORKFLOWS` +
 * `tengu_workflows_enabled`. No `enableWorkflows` / `allow_workflows` (153).
 */
export function isWorkflowsEnabled(): boolean {
  if (areWorkflowsDisabledByKillSwitch()) {
    return false
  }
  if (workflowsEnabledMemo !== undefined) {
    return workflowsEnabledMemo
  }
  if (!isEnvTruthy(process.env.CLAUDE_CODE_WORKFLOWS)) {
    workflowsEnabledMemo = false
  } else {
    workflowsEnabledMemo = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_workflows_enabled',
      true,
    )
  }
  return workflowsEnabledMemo
}
