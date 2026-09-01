import { z } from 'zod/v4'
import { getLastInteractionTime } from '../../bootstrap/state.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getTerminalFocusState } from '../../ink/terminal-focus-state.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getGlobalConfig } from '../../utils/config.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  DESCRIPTION,
  PROMPT,
  PUSH_NOTIFICATION_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const KAIROS_PUSH_REFRESH_MS = 300_000
/** Official 110 TO8 — idle threshold when terminal focus is unknown. */
const NOTIF_ACTIVE_THRESHOLD_MS = 60_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .min(1)
      .describe(
        'The notification body. Keep it under 200 characters; mobile OSes truncate.',
      ),
    status: z.literal('proactive'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    pushSent: z.boolean().optional(),
    localSent: z.boolean().optional(),
    disabledReason: z
      .enum(['config_off', 'user_present', 'bridge_inactive'])
      .optional(),
    idleSec: z.number().optional(),
    hasFocus: z.boolean().optional(),
    sentAt: z
      .string()
      .optional()
      .describe(
        'ISO timestamp captured at tool execution on the emitting process. Optional — resumed sessions replay pre-sentAt outputs verbatim.',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function isRemoteControlActive(): boolean {
  return getReplBridgeHandle() !== null
}

/**
 * Official 110 W61: if terminal focus is known, that wins; otherwise treat
 * the user as present when the last keystroke is within 60s.
 */
function isUserPresent(): boolean {
  const focus = getTerminalFocusState()
  if (focus !== 'unknown') {
    return focus === 'focused'
  }
  return Date.now() - getLastInteractionTime() < NOTIF_ACTIVE_THRESHOLD_MS
}

function knownHasFocus(): boolean | undefined {
  const focus = getTerminalFocusState()
  if (focus === 'unknown') return undefined
  return focus === 'focused'
}

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'send a notification to the user via terminal and optionally mobile',
  maxResultSizeChars: 1000,
  userFacingName() {
    return 'PushNotification'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isEnabled() {
    return getFeatureValue_CACHED_WITH_REFRESH(
      'tengu_kairos_push_notifications',
      false,
      KAIROS_PUSH_REFRESH_MS,
    )
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    if (output.disabledReason === 'config_off') {
      content = 'Push not sent — mobile push is disabled in /config.'
    } else if (output.disabledReason === 'user_present') {
      if (output.hasFocus === true) {
        content =
          'Not sent — terminal has focus. Terminal + mobile suppressed.'
      } else {
        const thresholdSec = NOTIF_ACTIVE_THRESHOLD_MS / 1000
        content = `Not sent — user active (last keystroke ${output.idleSec !== undefined ? `${output.idleSec}s` : `<${thresholdSec}s`} ago, threshold ${thresholdSec}s). Terminal + mobile suppressed.`
      }
    } else if (output.disabledReason === 'bridge_inactive') {
      content = output.localSent
        ? 'Terminal notification sent. Mobile push not sent (Remote Control inactive).'
        : 'Mobile push not sent (Remote Control inactive).'
    } else {
      content = output.localSent
        ? 'Terminal notification sent. Mobile push requested.'
        : 'Mobile push requested.'
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ message }: Input, context: ToolUseContext) {
    const sentAt = new Date().toISOString()
    const config = getGlobalConfig()
    const bridgeActive = isRemoteControlActive()
    if (bridgeActive && !(config.agentPushNotifEnabled ?? false)) {
      return {
        data: {
          message,
          pushSent: false,
          localSent: false,
          disabledReason: 'config_off' as const,
          sentAt,
        },
      }
    }
    const logSend = (pushSent: boolean, localSent: boolean) => {
      logEvent('tengu_push_notification_send', {
        message_length: message.length,
        push_sent: pushSent,
        local_sent: localSent,
      })
    }
    if (isUserPresent()) {
      const idleSec = Math.round(
        (Date.now() - getLastInteractionTime()) / 1000,
      )
      const hasFocus = knownHasFocus()
      logSend(false, false)
      return {
        data: {
          message,
          pushSent: false,
          localSent: false,
          disabledReason: 'user_present' as const,
          idleSec,
          ...(hasFocus !== undefined && { hasFocus }),
          sentAt,
        },
      }
    }
    const localSent = context.sendOSNotification !== undefined
    if (localSent) {
      context.sendOSNotification?.({
        message,
        notificationType: 'push_notification',
      })
    }
    if (!bridgeActive) {
      logSend(false, localSent)
      return {
        data: {
          message,
          pushSent: false,
          localSent,
          disabledReason: 'bridge_inactive' as const,
          sentAt,
        },
      }
    }
    logSend(true, localSent)
    return {
      data: {
        message,
        pushSent: true,
        localSent,
        sentAt,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
