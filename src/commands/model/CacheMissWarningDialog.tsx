import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'

type Props = {
  toModelLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/** Official 2.1.108 yiK — warn that switching models busts the prompt cache. */
export function CacheMissWarningDialog({
  toModelLabel,
  onConfirm,
  onCancel,
}: Props): React.ReactNode {
  return (
    <Dialog
      title="Switch model?"
      subtitle="Your next response will be slower and use more tokens"
      color="warning"
      onCancel={onCancel}
      hideInputGuide
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          This conversation is cached for the current model. Switching to{' '}
          <Text bold>{toModelLabel}</Text> means the full history gets re-read
          on your next message.
        </Text>
        <Select
          options={[
            { label: `Yes, switch to ${toModelLabel}`, value: 'yes' },
            { label: 'No, go back', value: 'no' },
          ]}
          onChange={value => (value === 'yes' ? onConfirm() : onCancel())}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
