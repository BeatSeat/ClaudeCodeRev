import * as React from 'react'
import { Box, Link, Text } from '../../ink.js'
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const SLACK_SEND_TOOLS = new Set(['slack_send_message', 'slack_post_message'])
const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{6,}$/

export function isSlackSendMessageTool(toolName: string): boolean {
  return SLACK_SEND_TOOLS.has(toolName)
}

function slackChannelLink(input: Record<string, unknown>): {
  label: string
  url: string | null
} | null {
  const raw = input.channel_id ?? input.channel
  if (typeof raw !== 'string' || !raw) {
    return null
  }
  const id = raw.replace(/^#/, '')
  const label = `#${id}`
  const url = SLACK_CHANNEL_ID_RE.test(id)
    ? `https://slack.com/app_redirect?channel=${id}`
    : null
  return { label, url }
}

export function slackSendMessageToolOverrides(): {
  userFacingName: () => string
  renderToolUseMessage: (
    input: Record<string, unknown>,
    options: { verbose: boolean },
  ) => string
  renderToolUseTag: (input: Record<string, unknown>) => React.ReactNode
} {
  return {
    userFacingName() {
      return 'Slacked'
    },
    renderToolUseMessage(input, { verbose }) {
      if (!verbose) {
        return ''
      }
      return Object.entries(input)
        .map(([key, value]) => `${key}: ${jsonStringify(value)}`)
        .join(', ')
    },
    renderToolUseTag(input) {
      const channel = slackChannelLink(input)
      if (channel === null) {
        return null
      }
      return (
        <Box flexWrap="nowrap" marginLeft={1}>
          <Text>
            {channel.url && supportsHyperlinks() ? (
              <Link url={channel.url}>{channel.label}</Link>
            ) : (
              channel.label
            )}
          </Text>
        </Box>
      )
    },
  }
}
