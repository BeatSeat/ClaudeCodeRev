import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  workerBadge?: WorkerBadgeProps
  /** Official 2.1.178 `fGH` — screen-reader prefix, e.g. "Permission Required:" */
  srPrefix?: string
}

export function PermissionRequestTitle({
  title,
  subtitle,
  color = 'permission',
  workerBadge,
  srPrefix,
}: Props): React.ReactNode {
  const ariaLabel = srPrefix !== undefined ? `${srPrefix} ${title}` : undefined
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box aria-label={ariaLabel}>
          <Text bold color={color}>
            {title}
          </Text>
        </Box>
        {workerBadge && (
          <Text dimColor>
            {'· '}@{workerBadge.name}
          </Text>
        )}
      </Box>
      {subtitle != null &&
        (typeof subtitle === 'string' ? (
          <Text dimColor wrap="truncate-start">
            {subtitle}
          </Text>
        ) : (
          subtitle
        ))}
    </Box>
  )
}
