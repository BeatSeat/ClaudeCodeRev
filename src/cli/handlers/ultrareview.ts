/**
 * Official 2.1.120 nE5 — `claude ultrareview [target]`.
 * Launches a cloud review with skipTaskRegistration and polls until
 * <remote-review> findings arrive (or timeout / archive / abort).
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import chalk from 'chalk'
import {
  checkOverageGate,
  confirmOverage,
  launchRemoteReviewSession,
} from '../../commands/review/reviewRemote.js'
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js'
import { REMOTE_REVIEW_PROGRESS_TAG } from '../../constants/xml.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import {
  extractReviewTagFromLog,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { createAbortController } from '../../utils/abortController.js'
import { checkAndRefreshOAuthTokenIfNeeded } from '../../utils/auth.js'
import { errorMessage } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { isTransientNetworkError } from '../../utils/teleport/api.js'
import { pollRemoteSessionEvents } from '../../utils/teleport.js'
import { cliError } from '../exit.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'

const POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MINUTES = 30
const MAX_TRANSIENT_FAILURES = 5
const REVIEW_DURATION_LABEL = '~10–20 min'

const SEVERITY_DOT: Record<string, string> = {
  normal: '🔴',
  nit: '🟡',
  pre_existing: '🟣',
}

type UltrareviewFinding = {
  severity?: string
  file_path?: string
  start_line?: number
  end_line?: number
  pr_comment?: string
}

function statusLine(msg: string): void {
  process.stderr.write(chalk.dim(msg) + '\n')
}

function blocksToText(
  blocks: { type: string; text?: string }[] | undefined,
): string {
  if (!blocks) return ''
  return blocks
    .map(b => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim()
}

/** Official 2.1.120 iE5 — payload `{error: string}` means the review failed. */
function extractReviewError(payload: string): string | null {
  try {
    const parsed = jsonParse(payload) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const err = (parsed as { error?: unknown }).error
      if (typeof err === 'string') return err
    }
  } catch {
    // not JSON
  }
  return null
}

/** Official 2.1.120 oE5 — last <remote-review-progress> heartbeat. */
function extractProgressLine(stdout: string): string | null {
  const open = `<${REMOTE_REVIEW_PROGRESS_TAG}>`
  const close = `</${REMOTE_REVIEW_PROGRESS_TAG}>`
  const closeAt = stdout.lastIndexOf(close)
  const openAt = closeAt === -1 ? -1 : stdout.lastIndexOf(open, closeAt)
  if (openAt === -1 || closeAt <= openAt) return null
  try {
    const parsed = jsonParse(stdout.slice(openAt + open.length, closeAt)) as {
      stage?: string
      bugs_found?: number
      bugs_verified?: number
      bugs_refuted?: number
    }
    const stage = parsed.stage ?? 'running'
    const found = parsed.bugs_found ?? 0
    const verified = parsed.bugs_verified ?? 0
    const refuted = parsed.bugs_refuted ?? 0
    return `${stage} — ${found} found, ${verified} verified, ${refuted} refuted`
  } catch {
    return null
  }
}

/** Official 2.1.120 aE5 — human-readable findings from bugs.json. */
function formatFindings(payload: string): string {
  let parsed: unknown
  try {
    parsed = jsonParse(payload)
  } catch {
    return payload
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return 'Review complete — no findings.'
  }
  const findings = parsed as UltrareviewFinding[]
  const lines = [
    chalk.bold(
      `Review complete — ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    ),
    '',
  ]
  for (const finding of findings) {
    const dot = SEVERITY_DOT[finding.severity ?? 'normal'] ?? '🔴'
    const file = finding.file_path ?? '?'
    const start = finding.start_line ?? 0
    const end = finding.end_line ?? start
    const loc = start === end ? `${file}:${start}` : `${file}:${start}-${end}`
    const comment = (finding.pr_comment ?? '').trim()
    const split = comment.indexOf('\n\n')
    const title = split === -1 ? comment : comment.slice(0, split)
    const body = split === -1 ? '' : comment.slice(split + 2)
    lines.push(`${dot} ${chalk.bold(loc)}`)
    if (title) lines.push(title)
    if (body) {
      lines.push('')
      lines.push(body)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Official 2.1.120 rE5 — poll until tagged review, archive, abort, or timeout. */
async function pollUltrareviewFindings(
  sessionId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let afterId: string | null = null
  let transientFailures = 0
  const accumulated: SDKMessage[] = []
  let lastProgress = ''

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('aborted')
    try {
      const response = await pollRemoteSessionEvents(sessionId, afterId)
      afterId = response.lastEventId ?? null
      transientFailures = 0
      if (response.sessionStatus === 'archived') {
        if (response.newEvents.length > 0) {
          accumulated.push(...response.newEvents)
        }
        return (
          extractReviewTagFromLog(accumulated) ??
          '{"error":"remote session was archived before producing output"}'
        )
      }
      if (response.newEvents.length > 0) {
        accumulated.push(...response.newEvents)
        for (const ev of response.newEvents) {
          if (
            ev.type === 'system' &&
            (ev.subtype === 'hook_progress' || ev.subtype === 'hook_response')
          ) {
            const line = extractProgressLine(ev.stdout)
            if (line && line !== lastProgress) {
              lastProgress = line
              statusLine(`  ${line}`)
            }
          }
        }
        const tagged = extractReviewTagFromLog(accumulated)
        if (tagged) return tagged
      }
    } catch (err) {
      if (signal.aborted || !isTransientNetworkError(err)) throw err
      if (++transientFailures >= MAX_TRANSIENT_FAILURES) {
        throw new Error(
          'lost connection to the remote session after repeated retries',
        )
      }
    }
    await sleep(POLL_INTERVAL_MS, signal)
  }
  throw new Error(
    `remote session exceeded ${Math.round(timeoutMs / 60000)} minutes`,
  )
}

export async function ultrareviewHandler(
  target: string,
  opts: { json?: boolean; timeout?: string },
): Promise<void> {
  const exitCancelled = (): never => process.exit(130)
  process.once('SIGINT', exitCancelled)

  if (!isPolicyAllowed('allow_remote_sessions')) {
    return cliError(
      "Remote sessions are disabled by your organization's policy.",
    )
  }
  await checkAndRefreshOAuthTokenIfNeeded().catch(() => {})

  if (!isUltrareviewEnabled()) {
    return cliError('Ultrareview is currently unavailable.')
  }

  const gate = await checkOverageGate()
  if (gate.kind === 'not-enabled') {
    return cliError(
      'Free ultrareviews used. Enable Extra Usage at https://claude.ai/settings/billing to continue.',
    )
  }
  if (gate.kind === 'low-balance') {
    return cliError(
      `Balance too low to launch ultrareview ($${gate.available.toFixed(2)} available, $10 minimum). Top up at https://claude.ai/settings/billing`,
    )
  }
  // Official Dz8 confirm:true — CLI proceeds and records the session flag.
  if (gate.kind === 'needs-confirm') {
    confirmOverage()
  }
  const billingNote =
    gate.kind === 'needs-confirm'
      ? ' This review bills as Extra Usage.'
      : gate.billingNote

  const parsedTimeout = Number(opts.timeout)
  const timeoutMinutes =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MINUTES

  const abortController = createAbortController()
  const launched = await launchRemoteReviewSession(
    target,
    { abortController },
    billingNote,
    { skipTaskRegistration: true },
  )

  if (!launched?.launched) {
    const body =
      blocksToText(launched?.blocks) ||
      'Failed to launch remote review session.'
    return cliError(`Ultrareview could not launch: ${body}`)
  }

  const message = blocksToText(launched.blocks)
  if (message) statusLine(message)
  statusLine(`View live progress in the browser: ${launched.sessionUrl}`)
  statusLine(`Waiting for findings (${REVIEW_DURATION_LABEL})…`)

  process.removeListener('SIGINT', exitCancelled)
  process.once('SIGINT', () => {
    statusLine(
      `\nCancelled. The remote review is still running — view it at ${launched.sessionUrl}`,
    )
    process.exit(130)
  })

  let payload: string
  try {
    payload = await pollUltrareviewFindings(
      launched.sessionId!,
      abortController.signal,
      timeoutMinutes * 60 * 1000,
    )
  } catch (err) {
    return cliError(
      `Ultrareview failed: ${errorMessage(err)}\nSession: ${launched.sessionUrl}`,
    )
  }

  const reviewError = extractReviewError(payload)
  if (opts.json) {
    process.stdout.write(payload + '\n')
    process.exit(reviewError ? 1 : 0)
  }
  if (reviewError) {
    return cliError(
      `Review failed: ${reviewError}\nSession: ${launched.sessionUrl}`,
    )
  }
  process.stdout.write(formatFindings(payload) + '\n')
  process.exit(0)
}
