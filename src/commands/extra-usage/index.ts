import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isOverageProvisioningAllowed } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

function isExtraUsageAllowed(): boolean {
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false
  }
  return isOverageProvisioningAllowed()
}

export const extraUsage = {
  type: 'local-jsx',
  name: 'usage-credits',
  description: 'Configure usage credits to keep working when you hit a limit',
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  load: () => import('./extra-usage.js'),
} satisfies Command

/** Official 2.1.113 — also in BRIDGE_SAFE_COMMANDS so RC clients can invoke /extra-usage. */
export const extraUsageNonInteractive = {
  type: 'local',
  name: 'usage-credits',
  supportsNonInteractive: true,
  description: 'Configure usage credits to keep working when you hit a limit',
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command

/**
 * Official 2.1.144: /extra-usage was renamed to /usage-credits. Keep the old
 * name working as a hidden alias so existing muscle-memory / docs still work.
 */
export const extraUsageLegacy = {
  type: 'local-jsx',
  name: 'extra-usage',
  description: 'Renamed to /usage-credits',
  isHidden: true,
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  load: () => import('./extra-usage.js'),
} satisfies Command

export const extraUsageLegacyNonInteractive = {
  type: 'local',
  name: 'extra-usage',
  supportsNonInteractive: true,
  description: 'Renamed to /usage-credits',
  isHidden: true,
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command
