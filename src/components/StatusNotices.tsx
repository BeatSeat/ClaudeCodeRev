import * as React from 'react'
import { use } from 'react'
import { Box } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { getMemoryFiles } from '../utils/claudemd.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  getMainLoopModel,
  isModeDependentModelSetting,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { stripTrailing1mSuffix } from '../utils/model/modelAllowlist.js'
import {
  getActiveNotices,
  type StatusNoticeContext,
} from '../utils/statusNoticeDefinitions.js'

type Props = {
  agentDefinitions?: AgentDefinitionsResult
}

/**
 * StatusNotices contains the information displayed to users at startup. We have
 * moved neutral or positive status to src/components/Status.tsx instead, which
 * users can access through /status.
 */
export function StatusNotices({
  agentDefinitions,
}: Props = {}): React.ReactNode {
  const storedRestricted = useAppState(
    s => s.setupIssues?.modelRestrictedWarning ?? null,
  )
  let modelRestrictedWarning: StatusNoticeContext['modelRestrictedWarning'] =
    null
  if (storedRestricted) {
    const currentModel = getMainLoopModel()
    const normalizedRequested = stripTrailing1mSuffix(
      storedRestricted.requested.trim().toLowerCase(),
    )
    if (
      !isModeDependentModelSetting(normalizedRequested) &&
      normalizedRequested !== 'best' &&
      parseUserSpecifiedModel(storedRestricted.requested).toLowerCase() ===
        currentModel.toLowerCase()
    ) {
      modelRestrictedWarning = null
    } else {
      modelRestrictedWarning = {
        requested: storedRestricted.requested,
        effective: currentModel,
      }
    }
  }
  const context: StatusNoticeContext = {
    config: getGlobalConfig(),
    agentDefinitions,
    memoryFiles: use(getMemoryFiles()),
    modelRestrictedWarning,
  }
  const activeNotices = getActiveNotices(context)
  if (activeNotices.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {activeNotices.map(notice => (
        <React.Fragment key={notice.id}>
          {notice.render(context)}
        </React.Fragment>
      ))}
    </Box>
  )
}
