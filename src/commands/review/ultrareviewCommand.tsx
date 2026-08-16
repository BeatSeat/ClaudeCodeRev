import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import React from 'react'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  checkOverageGate,
  confirmOverage,
  launchRemoteReview,
} from './reviewRemote.js'
import { UltrareviewLaunchDialog } from './UltrareviewLaunchDialog.js'

function contentBlocksToString(blocks: ContentBlockParam[]): string {
  return blocks
    .map(b => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

async function launchAndDone(
  args: string,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: LocalJSXCommandOnDone,
  billingNote: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await launchRemoteReview(args, context, billingNote)
  // User hit Escape during the ~5s launch — the dialog already showed
  // "cancelled" and unmounted, so skip onDone (would write to a dead
  // transcript slot) and let the caller skip confirmOverage.
  if (signal?.aborted) return
  if (result) {
    onDone(contentBlocksToString(result), { shouldQuery: true })
  } else {
    // Precondition failures now return specific ContentBlockParam[] above.
    // null only reaches here on teleport failure (PR mode) or non-github
    // repo — both are CCR/repo connectivity issues.
    onDone(
      'Ultrareview failed to launch the remote session. Check that this is a GitHub repo and try again.',
      { display: 'system' },
    )
  }
}

/** Official 2.1.108 `jpY`. */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const gate = await checkOverageGate()

  if (gate.kind === 'not-enabled') {
    onDone(
      'Free ultrareviews used. Enable Extra Usage at https://claude.ai/settings/billing to continue.',
      { display: 'system' },
    )
    return null
  }

  if (gate.kind === 'low-balance') {
    onDone(
      `Balance too low to launch ultrareview ($${gate.available.toFixed(2)} available, $10 minimum). Top up at https://claude.ai/settings/billing`,
      { display: 'system' },
    )
    return null
  }

  // Official 108: both needs-confirm and proceed go through jQK.
  const needsConfirm = gate.kind === 'needs-confirm'
  return (
    <UltrareviewLaunchDialog
      subtitle={needsConfirm ? null : gate.billingNote || null}
      body={
        needsConfirm
          ? 'Your free ultrareviews for this organization are used. Further reviews bill as Extra Usage (pay-per-use).'
          : undefined
      }
      onProceed={async signal => {
        await launchAndDone(
          args,
          context,
          onDone,
          needsConfirm ? ' This review bills as Extra Usage.' : gate.billingNote,
          signal,
        )
        if (!signal.aborted && needsConfirm) confirmOverage()
      }}
      onCancel={() => onDone('Ultrareview cancelled.', { display: 'system' })}
    />
  )
}
