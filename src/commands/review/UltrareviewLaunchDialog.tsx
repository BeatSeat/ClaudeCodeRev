import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Link, Text } from '../../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { CCR_TERMS_URL } from '../review.js'

type Props = {
  /** Official jQK `subtitle` — billing note, or null → `~10–20 min`. */
  subtitle?: string | null
  /** Official jQK `body` — overage / quota copy. */
  body?: string
  onProceed: (signal: AbortSignal) => Promise<void>
  onCancel: () => void
}

/**
 * Official 2.1.108 `jQK` / `OpY` / `ApY` / `zpY`.
 * Always confirm before launching; first launch also shows CCR terms.
 */
export function UltrareviewLaunchDialog({
  subtitle,
  body,
  onProceed,
  onCancel,
}: Props): React.ReactNode {
  const showTerms = useMemo(
    () => !getGlobalConfig().hasSeenUltrareviewTerms,
    [],
  )
  const [isLaunching, setIsLaunching] = useState(false)
  const abortControllerRef = useRef(new AbortController())

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'proceed') {
        if (showTerms) {
          saveGlobalConfig(current =>
            current.hasSeenUltrareviewTerms
              ? current
              : { ...current, hasSeenUltrareviewTerms: true },
          )
        }
        setIsLaunching(true)
        void onProceed(abortControllerRef.current.signal).catch(() =>
          setIsLaunching(false),
        )
      } else {
        onCancel()
      }
    },
    [onProceed, onCancel, showTerms],
  )

  const handleCancel = useCallback(() => {
    abortControllerRef.current.abort()
    onCancel()
  }, [onCancel])

  const options = showTerms
    ? [
        {
          label: 'Yes',
          value: 'proceed',
          description: 'launch in Claude Code on the web',
        },
        { label: 'No', value: 'cancel' },
      ]
    : [
        {
          label: 'Run ultrareview',
          value: 'proceed',
          description: 'launch in Claude Code on the web',
        },
        { label: 'Not now', value: 'cancel' },
      ]

  return (
    <Dialog
      title="Run ultrareview in the cloud?"
      subtitle={subtitle ?? '~10–20 min'}
      onCancel={handleCancel}
      color="background"
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>
            Finds and verifies bugs in your branch using a multi-agent review
            fleet.
          </Text>
          {body ? <Text dimColor>{body}</Text> : null}
          {showTerms ? (
            <Text dimColor>
              More information: <Link url={CCR_TERMS_URL}>{CCR_TERMS_URL}</Link>
            </Text>
          ) : null}
        </Box>
        {showTerms ? <Text>Proceed?</Text> : null}
        {isLaunching ? (
          <Text color="background">Launching…</Text>
        ) : (
          <Select
            options={options}
            onChange={handleSelect}
            onCancel={handleCancel}
          />
        )}
      </Box>
    </Dialog>
  )
}
