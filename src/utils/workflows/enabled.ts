import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../envUtils.js'

/** Official 2.1.146 `CN` — `CLAUDE_CODE_WORKFLOWS` + `tengu_workflows_enabled`. */
let workflowsEnabledMemo: boolean | undefined

export function isWorkflowsEnabled(): boolean {
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
