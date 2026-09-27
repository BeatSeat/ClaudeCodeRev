import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from 'src/ink.js'
import { formatAPIError } from 'src/services/api/errorUtils.js'
import {
  extractRateLimitFromError,
  getRateLimitDisplayName,
} from 'src/services/claudeAiLimits.js'
import { isImmediateNetworkError } from 'src/utils/errors.js'
import { formatDuration, formatResetTime } from 'src/utils/format.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { useInterval } from 'usehooks-ts'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'

const MAX_API_ERROR_CHARS = 1000

type Props = {
  message: SystemAPIErrorMessage
  verbose: boolean
}

export function SystemAPIErrorMessage({
  message: { retryAttempt, error, retryInMs, maxRetries },
  verbose,
}: Props): React.ReactNode {
  // Hidden for early retries on external builds to avoid noise. Compute before
  // useInterval so we never register a timer that just drives a null render.
  const hidden =
    "external" === 'external' &&
    retryAttempt < 4 &&
    !isImmediateNetworkError(error)

  const rateLimit = extractRateLimitFromError(error)
  const resetTime = rateLimit?.resetsAt
    ? formatResetTime(rateLimit.resetsAt)
    : undefined
  const [countdownMs, setCountdownMs] = useState(0)
  const remainingMs = Math.max(0, retryInMs - countdownMs)
  const updateIntervalMs = remainingMs > 60_000 ? 60_000 : 1000
  useInterval(
    () => setCountdownMs(ms => ms + updateIntervalMs),
    hidden || remainingMs === 0 ? null : updateIntervalMs,
  )

  if (hidden) {
    return null
  }

  const retryDuration = formatDuration(remainingMs, {
    mostSignificantOnly: true,
  })
  const resetSuffix = resetTime ? ` (${resetTime})` : ''
  const retryStatus = (
    <Text dimColor>
      Retrying in {retryDuration}
      {resetSuffix} · attempt {retryAttempt}/{maxRetries}
      {process.env.API_TIMEOUT_MS
        ? ` · API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it`
        : ''}
    </Text>
  )

  if (rateLimit) {
    const displayName = rateLimit.rateLimitType
      ? getRateLimitDisplayName(rateLimit.rateLimitType)
      : 'usage limit'
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Text>
            <Text color="error">
              {displayName.charAt(0).toUpperCase() + displayName.slice(1)}{' '}
              reached
            </Text>
          </Text>
          {retryStatus}
        </Box>
      </MessageResponse>
    )
  }

  const formatted = formatAPIError(error)
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">
          {truncated
            ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…'
            : formatted}
        </Text>
        {truncated && <CtrlOToExpand />}
        {retryStatus}
      </Box>
    </MessageResponse>
  )
}
