import * as React from 'react'
import { Select } from './CustomSelect/select.js'

/**
 * Generic two-option confirm/cancel selector (Official 2.1.169). Renders a
 * Yes/No pair built on Select; defaults focus to the confirm option and
 * treats Esc as cancel.
 */
export function ConfirmDialog({
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  cancelFirst = false,
  focus = 'confirm',
}: {
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  cancelLabel?: string
  cancelFirst?: boolean
  focus?: 'confirm' | 'cancel'
}): React.ReactNode {
  const confirmOption = {
    label: confirmLabel ?? 'Yes',
    value: 'confirm' as const,
  }
  const cancelOption = {
    label: cancelLabel ?? 'No',
    value: 'cancel' as const,
  }
  const options = cancelFirst
    ? [cancelOption, confirmOption]
    : [confirmOption, cancelOption]
  return (
    <Select
      options={options}
      defaultFocusValue={focus}
      onChange={value => (value === 'confirm' ? onConfirm() : onCancel())}
      onCancel={onCancel}
    />
  )
}
