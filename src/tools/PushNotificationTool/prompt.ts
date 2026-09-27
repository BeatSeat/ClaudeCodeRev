import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getGlobalConfig } from '../../utils/config.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

export const DESCRIPTION =
  'Send a notification to the user via their terminal and, when Remote Control is connected, also push to their mobile device'

export const PROMPT = `This tool sends a desktop notification in the user's terminal. If Remote Control is connected, it also pushes to their phone. Either way, it pulls their attention from whatever they're doing — a meeting, another task, dinner — to this session. That's the cost. The benefit is they learn something now that they'd want to know now: a long task finished while they were away, a build is ready, you've hit something that needs their decision before you can continue.

Because a notification they didn't need is annoying in a way that accumulates, err toward not sending one. Don't notify for routine progress, or to announce you've answered something they asked seconds ago and are clearly still watching, or when a quick task completes. Notify when there's a real chance they've walked away and there's something worth coming back for — or when they've explicitly asked you to notify them.

Keep the message under 200 characters, one line, no markdown. Lead with what they'd act on — "build failed: 2 auth tests" tells them more than "task done" and more than a status dump.

If the result says the push wasn't sent, that's expected — no action needed.`

/** Official l56(): kairos push GB + "Push when Claude decides". */
export function isPushWhenClaudeDecidesEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_kairos_push_notifications',
      false,
    ) && getGlobalConfig().agentPushNotifEnabled === true
  )
}

/**
 * Official 110 ki1(). Concatenated onto Monitor description/prompt only,
 * not the default system-prompt assembler.
 */
export function getPushNotificationPromptSection(): string {
  return `

When an event lands that the user would want to act on now — an error appeared, the status they were waiting on flipped — send a ${PUSH_NOTIFICATION_TOOL_NAME}. Not every event is worth a push; the ones that change what they'd do next are.`
}

/** Official TM6 suffix on a monitor event when l56() and not housekeeping. */
export function getPushNotificationEventHint(): string {
  return `If this event is something the user would act on now, send a ${PUSH_NOTIFICATION_TOOL_NAME}. Routine or benign output doesn't need one.`
}
