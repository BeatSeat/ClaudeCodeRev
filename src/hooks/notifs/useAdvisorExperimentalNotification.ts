import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { useAppState } from '../../state/AppState.js'
import {
  canUserConfigureAdvisor,
  modelSupportsAdvisor,
} from '../../utils/advisor.js'
import { useMainLoopModel } from '../useMainLoopModel.js'

/**
 * Startup toast when Advisor Tool is enabled. Official 2.1.117 H14.
 */
export function useAdvisorExperimentalNotification(): void {
  const { addNotification } = useNotifications()
  const advisorModel = useAppState(s => s.advisorModel)
  const mainModel = useMainLoopModel()
  const shownRef = useRef(false)

  useEffect(() => {
    if (getIsRemoteMode() || !canUserConfigureAdvisor()) {
      return
    }
    if (!advisorModel) {
      shownRef.current = false
      return
    }
    if (!modelSupportsAdvisor(mainModel) || shownRef.current) {
      return
    }
    shownRef.current = true
    addNotification({
      key: 'advisor-experimental',
      text: 'Advisor Tool (experimental) is on and may use more tokens · /advisor',
      priority: 'medium',
    })
  }, [advisorModel, mainModel, addNotification])
}
