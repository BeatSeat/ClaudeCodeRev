import { Text } from '../../ink.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { readLastUpdateResult } from '../../utils/lastUpdateResult.js'
import { logEvent } from '../../services/analytics/index.js'
import { useStartupNotification } from './useStartupNotification.js'

const NOTICE_ID = 'sudo-npm-install'

export function useSudoNpmInstallNotice(): void {
  useStartupNotification(async () => {
    if (isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
      return null
    }
    const seen = getGlobalConfig().seenNotifications?.[NOTICE_ID] ?? 0
    if (seen >= 1) return null
    const result = await readLastUpdateResult()
    if (
      result?.path !== 'npm-global' ||
      result.outcome !== 'failed' ||
      result.status !== 'no_permissions'
    ) {
      return null
    }
    saveGlobalConfig(current => ({
      ...current,
      seenNotifications: {
        ...current.seenNotifications,
        [NOTICE_ID]: seen + 1,
      },
    }))
    logEvent('sudo_npm_install_notice', {})
    return {
      key: NOTICE_ID,
      jsx: (
        <Text color="warning">
          {"Claude Code can't auto-update"}
          <Text dimColor> {' \u00B7 run `/doctor`'}</Text>
        </Text>
      ),
      priority: 'high',
      timeoutMs: 15000,
    }
  })
}
