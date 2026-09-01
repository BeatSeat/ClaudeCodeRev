import { useEffect } from 'react'
import {
  useAppState,
  useAppStateStore,
} from '../state/AppState.js'
import {
  armPluginMonitors,
  subscribeSkillInvoked,
} from '../utils/plugins/pluginMonitors.js'

/**
 * Official N95: arm plugin monitors with when==="always" on mount, and
 * on-skill-invoke:<skill> the first time that skill is dispatched.
 */
export function usePluginMonitors({
  enabled = true,
}: {
  enabled?: boolean
} = {}): void {
  const store = useAppStateStore()
  const enabledPlugins = useAppState(s => s.plugins.enabled)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const makeContext = () => ({
      abortController: new AbortController(),
      getAppState: () => store.getState(),
      setAppState: store.setState,
    })
    void armPluginMonitors(
      enabledPlugins,
      monitor => monitor.when === 'always',
      makeContext(),
    )
    return subscribeSkillInvoked(skillName => {
      void armPluginMonitors(
        store.getState().plugins.enabled,
        monitor => monitor.when === `on-skill-invoke:${skillName}`,
        makeContext(),
      )
    })
  }, [enabled, enabledPlugins, store])
}
