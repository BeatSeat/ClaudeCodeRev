import { feature } from 'bun:bundle'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import type { Command } from '../../commands.js'

function isEnabled(): boolean {
  if (!feature('BRIDGE_MODE')) {
    return false
  }
  return isBridgeEnabled()
}

/** Official 2.1.154 `rk` — session already has Remote Control. */
let remoteControlActive = false
export function setRemoteControlActive(active: boolean): void {
  remoteControlActive = active
}

const bridge = {
  type: 'local-jsx',
  name: 'remote-control',
  aliases: ['rc'],
  get description() {
    return remoteControlActive
      ? 'Disconnect Remote Control'
      : 'Control this session from your phone or claude.ai/code'
  },
  get argumentHint() {
    return remoteControlActive ? undefined : '[name]'
  },
  isEnabled,
  get isHidden() {
    return !isEnabled()
  },
  immediate: true,
  load: () => import('./bridge.js'),
} satisfies Command

export default bridge
