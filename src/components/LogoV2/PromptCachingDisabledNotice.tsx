import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const DISABLE_PROMPT_CACHING_VARS = [
  'DISABLE_PROMPT_CACHING',
  'DISABLE_PROMPT_CACHING_HAIKU',
  'DISABLE_PROMPT_CACHING_OPUS',
  'DISABLE_PROMPT_CACHING_SONNET',
] as const

/** Official 2.1.108 Nw7 / YmY */
export function PromptCachingDisabledNotice(): React.ReactNode {
  const set = DISABLE_PROMPT_CACHING_VARS.filter(name =>
    isEnvTruthy(process.env[name]),
  )
  if (set.length === 0) return null

  return (
    <Box flexDirection="row">
      <Text color="error">● </Text>
      <Box flexDirection="column">
        <Text color="error">
          Prompt caching disabled via {set.join(', ')}. This will impact
          latency and token costs.
        </Text>
        <Text dimColor>
          We highly recommend disabling{' '}
          {set.length === 1
            ? 'this environment variable'
            : 'these environment variables'}
        </Text>
      </Box>
    </Box>
  )
}
