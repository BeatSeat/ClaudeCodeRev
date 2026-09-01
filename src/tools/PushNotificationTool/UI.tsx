import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { Output } from './PushNotificationTool.js'

export function renderToolUseMessage(input: { message?: string }): string {
  if (!input.message) return ''
  return input.message
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  let body: React.ReactNode
  if (output.disabledReason === 'config_off') {
    body = (
      <Box flexDirection="row">
        <Text>
          Not sent because "Push when Claude decides" is disabled in{' '}
        </Text>
        <Text>/config</Text>
        <Text>.</Text>
      </Box>
    )
  } else if (output.disabledReason === 'user_present') {
    body = <Text>Not sent because you're active in this terminal.</Text>
  } else if (output.disabledReason === 'bridge_inactive') {
    body = output.localSent ? (
      <Text>Terminal notification sent.</Text>
    ) : (
      <Box flexDirection="row">
        <Text>Not sent — Remote Control is off. Enable with </Text>
        <Text>/remote-control</Text>
        <Text>.</Text>
      </Box>
    )
  } else {
    if (output.localSent === undefined) return null
    body = (
      <Text>
        {output.localSent
          ? 'Terminal and mobile notification sent.'
          : 'Mobile notification sent.'}
      </Text>
    )
  }
  return <MessageResponse height={1}>{body}</MessageResponse>
}
