import React from 'react'
import { Text } from '../../ink.js'
import { StatusIcon } from './StatusIcon.js'

type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading'

type Props = {
  title: string
  status?: Status
  detail?: string
}

/** Official 2.1.178 `TZ` — bold title + status icon + optional dim detail. */
export function DoctorSectionTitle({
  title,
  status,
  detail,
}: Props): React.ReactNode {
  return (
    <Text>
      <Text bold>{title}</Text>
      {status ? (
        <>
          {' '}
          <StatusIcon status={status} />
        </>
      ) : null}
      {detail ? <Text dimColor> · {detail}</Text> : null}
    </Text>
  )
}
