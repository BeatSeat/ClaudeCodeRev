import React from 'react'
import type { Root } from '../../ink.js'
import { AppStateProvider } from '../../state/AppState.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import instances from '../../ink/instances.js'
import { FleetView } from './FleetView.js'
import type { FleetGroupMode, FleetViewAction } from './types.js'
import {
  attachThenRemount,
  handoffAltScreen,
  handoffRawMode,
} from './attachFleetJob.js'
import { bgAgentAction } from './fleetTelemetry.js'

/**
 * Official 2.1.139 `GQ5` — list → attach/respawn → remount loop.
 */
export async function mountFleetView(root: Root): Promise<void> {
  bgAgentAction('list_open')

  let current = root
  let selectId = process.env.CLAUDE_AGENTS_SELECT
  delete process.env.CLAUDE_AGENTS_SELECT
  let initialQuery: string | undefined
  let initialCollapsed: string[] | undefined
  let initialError: string | undefined
  let initialGroupMode: FleetGroupMode | undefined

  for (;;) {
    const action = await new Promise<FleetViewAction>(resolve => {
      current.render(
        <AppStateProvider onChangeAppState={onChangeAppState}>
          <KeybindingSetup>
            <FleetView
              onAction={resolve}
              initialJobId={selectId}
              initialQuery={initialQuery}
              initialCollapsed={initialCollapsed}
              initialError={initialError}
              initialGroupMode={initialGroupMode}
            />
          </KeybindingSetup>
        </AppStateProvider>,
      )
    })

    const alreadyInAlt = instances.get(process.stdout)?.isAltScreenActive ?? false
    if (alreadyInAlt && action.type === 'open') handoffAltScreen()
    if (getPlatform() === 'windows' && action.type === 'open') handoffRawMode()
    if (!alreadyInAlt) current.render(null)
    current.unmount()
    initialError = undefined
    if (action.type === 'done') break

    selectId = action.job.id
    initialQuery = action.query
    initialCollapsed = action.collapsed
    initialGroupMode = action.groupMode

    const remounted = await attachThenRemount(current, action.job.id, action.job.state, {
      alreadyInAlt,
      freshDispatch: action.freshDispatch,
      statuses: action.statuses,
      statusesTs: action.statusesTs,
      respawnResult: action.respawnResult,
    })
    current = remounted.root
    initialError = remounted.initialError
  }
}
