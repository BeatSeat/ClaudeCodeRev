import * as React from 'react'
import { Text } from 'src/ink.js'
import { truncate } from '../../utils/truncate.js'

export function userFacingName(): string {
  return 'Monitor'
}

export function renderToolUseMessage(
  input: { description?: string } | undefined,
): string | null {
  if (!input?.description) return null
  return input.description
}

export function renderToolResultMessage(output: {
  taskId: string
  timeoutMs: number
  persistent?: boolean
}): React.ReactNode {
  return (
    <Text>
      Monitor started{' '}
      <Text dimColor>
        · task {output.taskId} ·{' '}
        {output.persistent
          ? 'persistent'
          : `timeout ${output.timeoutMs / 1000}s`}
      </Text>
    </Text>
  )
}

export function getToolUseSummary(
  input: { description?: string } | undefined,
): string | null {
  if (!input?.description) return null
  return truncate(input.description, 40)
}
