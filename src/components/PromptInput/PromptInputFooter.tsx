import { feature } from 'bun:bundle'
import * as React from 'react'
import { memo, type ReactNode, useMemo, useRef } from 'react'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import { getBridgeStatus } from '../../bridge/bridgeStatusUtil.js'
import { useSetPromptOverlay } from '../../context/promptOverlayContext.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { usePrStatus } from '../../hooks/usePrStatus.js'
import { useSettings } from '../../hooks/useSettings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { useAppState } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getGlobalConfig } from '../../utils/config.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { isUndercover } from '../../utils/undercover.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { PrBadge } from '../PrBadge.js'
import {
  CoordinatorTaskPanel,
  useCoordinatorTaskCount,
} from '../CoordinatorAgentStatus.js'
import {
  getLastAssistantMessageId,
  StatusLine,
  statusLineShouldDisplay,
} from '../StatusLine.js'
import { Notifications } from './Notifications.js'
import { PromptInputFooterLeftSide } from './PromptInputFooterLeftSide.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from './PromptInputFooterSuggestions.js'
import { PromptInputHelpMenu } from './PromptInputHelpMenu.js'

type Props = {
  apiKeyStatus: VerificationStatus
  debug: boolean
  exitMessage: {
    show: boolean
    key?: string
  }
  vimMode: VimMode | undefined
  mode: PromptInputMode
  autoUpdaterResult: AutoUpdaterResult | null
  isAutoUpdating: boolean
  verbose: boolean
  onAutoUpdaterResult: (result: AutoUpdaterResult | null) => void
  onChangeIsUpdating: (isUpdating: boolean) => void
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  suggestionsEmptyMessage?: string
  maxColumnWidth?: number
  toolPermissionContext: ToolPermissionContext
  helpOpen: boolean
  suppressHint: boolean
  isLoading: boolean
  tasksSelected: boolean
  teamsSelected: boolean
  bridgeSelected: boolean
  tmuxSelected: boolean
  teammateFooterIndex?: number
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isPasting?: boolean
  isInputWrapped?: boolean
  messages: Message[]
  isSearching: boolean
  historyQuery: string
  setHistoryQuery: (query: string) => void
  historyFailedMatch: boolean
  onOpenTasksDialog?: (taskId?: string) => void
}

function PromptInputFooter({
  apiKeyStatus,
  debug,
  exitMessage,
  vimMode,
  mode,
  autoUpdaterResult,
  isAutoUpdating,
  verbose,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  suggestions,
  selectedSuggestion,
  suggestionsEmptyMessage,
  maxColumnWidth,
  toolPermissionContext,
  helpOpen,
  suppressHint: suppressHintFromProps,
  isLoading,
  tasksSelected,
  teamsSelected,
  bridgeSelected,
  tmuxSelected,
  teammateFooterIndex,
  ideSelection,
  mcpClients,
  isPasting = false,
  isInputWrapped = false,
  messages,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog,
}: Props): ReactNode {
  const settings = useSettings()
  const { columns, rows } = useTerminalSize()
  const copperThistle = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_copper_thistle',
    false,
  )
  const prStatus = usePrStatus(
    isLoading,
    getGlobalConfig().prStatusFooterEnabled ?? true,
  )
  const showRightPr =
    copperThistle &&
    (getGlobalConfig().prStatusFooterEnabled ?? true) &&
    prStatus.number !== null &&
    prStatus.url !== null &&
    prStatus.reviewState !== null
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const lastAssistantMessageId = useMemo(
    () => getLastAssistantMessageId(messages),
    [messages],
  )
  // In fullscreen the bottom slot is flexShrink:0, so every row here is a row
  // stolen from the ScrollBox. Drop the optional StatusLine first. Non-fullscreen
  // has terminal scrollback to absorb overflow, so we never hide StatusLine there.
  const isFullscreen = isFullscreenEnvEnabled()
  const briefTranscript = useAppState(s => s.briefTranscript)
  const isShort = isFullscreen && rows < 15
  const footerRowLabels = [false, isFullscreen && briefTranscript && 'focus'].filter(
    (label): label is string => Boolean(label),
  )

  // Pill highlights when tasks is the active footer item AND no specific
  // agent row is selected. When coordinatorTaskIndex >= 0 the pointer has
  // moved into CoordinatorTaskPanel, so the pill should un-highlight.
  // coordinatorTaskCount === 0 covers the bash-only case (no agent rows
  // exist, pill is the only selectable item).
  const coordinatorTaskCount = useCoordinatorTaskCount()
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex)
  const pillSelected =
    tasksSelected && (coordinatorTaskCount === 0 || coordinatorTaskIndex < 0)

  // Hide `? for shortcuts` if the user has a custom status line, or during ctrl-r
  const suppressHint =
    suppressHintFromProps || statusLineShouldDisplay(settings) || isSearching
  // Fullscreen: portal data to FullscreenLayout — see promptOverlayContext.tsx
  const showSuggestions =
    suggestions.length > 0 || Boolean(suggestionsEmptyMessage)
  const overlayData = useMemo(
    () =>
      isFullscreen && showSuggestions
        ? {
            suggestions,
            selectedSuggestion,
            maxColumnWidth,
            emptyMessage: suggestionsEmptyMessage,
          }
        : null,
    [
      isFullscreen,
      showSuggestions,
      suggestions,
      selectedSuggestion,
      maxColumnWidth,
      suggestionsEmptyMessage,
    ],
  )
  useSetPromptOverlay(overlayData)

  if (showSuggestions && !isFullscreen) {
    return (
      <Box paddingX={2} paddingY={0}>
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          maxColumnWidth={maxColumnWidth}
          emptyMessage={suggestionsEmptyMessage}
        />
      </Box>
    )
  }

  if (helpOpen) {
    return (
      <PromptInputHelpMenu dimColor={true} fixedWidth={true} paddingX={2} />
    )
  }

  return (
    <>
      <Box
        width={columns}
        flexWrap="wrap"
        alignItems="flex-end"
        paddingLeft={2}
        paddingRight={isFullscreen ? 1 : 2}
        columnGap={1}
      >
        <Box flexDirection="column" flexShrink={1}>
          {mode === 'prompt' &&
            !isShort &&
            !exitMessage.show &&
            !isPasting &&
            statusLineShouldDisplay(settings) && (
              <StatusLine
                messagesRef={messagesRef}
                lastAssistantMessageId={lastAssistantMessageId}
                vimMode={vimMode}
              />
            )}
          <PromptInputFooterLeftSide
            exitMessage={exitMessage}
            vimMode={vimMode}
            hideVimModeIndicator={
              !isShort &&
              statusLineShouldDisplay(settings) &&
              (settings.statusLine?.hideVimModeIndicator ?? false)
            }
            mode={mode}
            toolPermissionContext={toolPermissionContext}
            suppressHint={suppressHint}
            isLoading={isLoading}
            tasksSelected={pillSelected}
            teamsSelected={teamsSelected}
            teammateFooterIndex={teammateFooterIndex}
            tmuxSelected={tmuxSelected}
            isPasting={isPasting}
            isSearching={isSearching}
            historyQuery={historyQuery}
            setHistoryQuery={setHistoryQuery}
            historyFailedMatch={historyFailedMatch}
            onOpenTasksDialog={onOpenTasksDialog}
          />
        </Box>
        <Box flexShrink={0} marginLeft="auto" gap={1}>
          {isFullscreen ? null : (
            <Notifications
              apiKeyStatus={apiKeyStatus}
              autoUpdaterResult={autoUpdaterResult}
              debug={debug}
              isAutoUpdating={isAutoUpdating}
              verbose={verbose}
              messages={messages}
              onAutoUpdaterResult={onAutoUpdaterResult}
              onChangeIsUpdating={onChangeIsUpdating}
              ideSelection={ideSelection}
              mcpClients={mcpClients}
              isInputWrapped={isInputWrapped}
            />
          )}
          {"external" === 'ant' && isUndercover() && (
            <Text dimColor>undercover</Text>
          )}
          {showRightPr && (
            <PrBadge
              number={prStatus.number!}
              url={prStatus.url!}
              reviewState={prStatus.reviewState!}
            />
          )}
          {columns >= 60 && (
            <BridgeStatusIndicator bridgeSelected={bridgeSelected} />
          )}
          {footerRowLabels.length > 0 && (
            <Text dimColor>{footerRowLabels.join(' & ')}</Text>
          )}
        </Box>
      </Box>
      {"external" === 'ant' && <CoordinatorTaskPanel />}
    </>
  )
}

export default memo(PromptInputFooter)

type BridgeStatusProps = {
  bridgeSelected: boolean
}

function BridgeStatusIndicator({
  bridgeSelected,
}: BridgeStatusProps): React.ReactNode {
  if (!feature('BRIDGE_MODE')) return null

  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const enabled = useAppState(s => s.replBridgeEnabled)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const connected = useAppState(s => s.replBridgeConnected)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const sessionActive = useAppState(s => s.replBridgeSessionActive)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const reconnecting = useAppState(s => s.replBridgeReconnecting)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const explicit = useAppState(s => s.replBridgeExplicit)

  // Failed state is surfaced via notification (useReplBridge), not a footer pill.
  if (!isBridgeEnabled() || !enabled) return null

  const status = getBridgeStatus({
    error: undefined,
    connected,
    sessionActive,
    reconnecting,
  })

  // For implicit (config-driven) remote, only show the reconnecting state
  if (!explicit && status.label !== '/rc reconnecting') {
    return null
  }

  return (
    <Text
      color={bridgeSelected ? 'background' : status.color}
      inverse={bridgeSelected}
      wrap="truncate"
    >
      {status.label}
      {bridgeSelected && (
        <Text dimColor>
          {' · '}
          <KeyboardShortcutHint chord="enter" action="view" />
        </Text>
      )}
    </Text>
  )
}
