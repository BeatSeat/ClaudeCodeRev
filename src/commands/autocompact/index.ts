import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const autocompact: Command = {
  type: 'local-jsx',
  name: 'autocompact',
  description: 'Set how full the context gets before auto-summarizing',
  isEnabled: () => !getIsNonInteractiveSession(),
  isHidden: false,
  argumentHint: '[tokens|reset]',
  load: () => import('./autocompact.js'),
  userFacingName() {
    return 'autocompact'
  },
}

export const autocompactNonInteractive: Command = {
  type: 'local',
  name: 'autocompact',
  supportsNonInteractive: true,
  description: 'Set how full the context gets before auto-summarizing',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  argumentHint: '[tokens|reset]',
  load: () => import('./print.js'),
  userFacingName() {
    return 'autocompact'
  },
}
