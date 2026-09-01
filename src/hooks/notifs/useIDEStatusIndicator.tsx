import React, { useEffect, useRef } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { Text } from 'src/ink.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import {
  detectIDEs,
  type IDEExtensionInstallationStatus,
  isJetBrainsIde,
  isSupportedTerminal,
} from 'src/utils/ide.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useIdeConnectionStatus } from '../useIdeConnectionStatus.js'
import type { IDESelection } from '../useIdeSelection.js'

const MAX_IDE_HINT_SHOW_COUNT = 5

type Props = {
  ideInstallationStatus: IDEExtensionInstallationStatus | null
  ideSelection: IDESelection | undefined
  mcpClients: MCPServerConnection[]
}

export function useIDEStatusIndicator({
  ideSelection,
  mcpClients,
  ideInstallationStatus,
}: Props): void {
  const { addNotification, removeNotification } = useNotifications()
  const { status: ideStatus, ideName } = useIdeConnectionStatus(mcpClients)
  const hasShownHintRef = useRef(false)

  const isJetBrains = ideInstallationStatus
    ? isJetBrainsIde(ideInstallationStatus?.ideType)
    : false
  const showIDEInstallErrorOrJetBrainsInfo =
    ideInstallationStatus?.error || isJetBrains

  const shouldShowIdeSelection =
    ideStatus === 'connected' &&
    (ideSelection?.filePath ||
      (ideSelection?.text && ideSelection.lineCount > 0))

  // Only show the connected if not showing context
  const shouldShowConnected =
    ideStatus === 'connected' && !shouldShowIdeSelection

  const showIDEInstallError =
    showIDEInstallErrorOrJetBrainsInfo &&
    !isJetBrains &&
    !shouldShowConnected &&
    !shouldShowIdeSelection

  const showJetBrainsInfo =
    showIDEInstallErrorOrJetBrainsInfo &&
    isJetBrains &&
    !shouldShowConnected &&
    !shouldShowIdeSelection

  // Official 2.1.157: "/ide for …" startup hint toast removed.
  useEffect(() => {
    removeNotification('ide-status-hint')
  }, [removeNotification])

  // Show IDE disconnected/failed notification when status is disconnected
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (
      showIDEInstallError ||
      showJetBrainsInfo ||
      ideStatus !== 'disconnected' ||
      !ideName
    ) {
      removeNotification('ide-status-disconnected')
      return
    }
    addNotification({
      key: 'ide-status-disconnected',
      text: `${ideName} disconnected`,
      color: 'error',
      priority: 'medium',
    })
  }, [
    addNotification,
    removeNotification,
    ideStatus,
    ideName,
    showIDEInstallError,
    showJetBrainsInfo,
  ])

  // Show JetBrains plugin not connected hint
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (!showJetBrainsInfo) {
      removeNotification('ide-status-jetbrains-disconnected')
      return
    }
    addNotification({
      key: 'ide-status-jetbrains-disconnected',
      text: 'IDE plugin not connected · /status for info',
      priority: 'medium',
    })
  }, [addNotification, removeNotification, showJetBrainsInfo])

  // Show IDE install error
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (!showIDEInstallError) {
      removeNotification('ide-status-install-error')
      return
    }
    addNotification({
      key: 'ide-status-install-error',
      text: 'IDE extension install failed (see /status for info)',
      color: 'error',
      priority: 'medium',
    })
  }, [addNotification, removeNotification, showIDEInstallError])
}
