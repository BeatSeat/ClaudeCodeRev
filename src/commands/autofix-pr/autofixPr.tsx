import figures from 'figures'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { getRemoteSessionUrl } from '../../constants/product.js'
import { Box, Link, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  registerRemoteAgentTask,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import {
  getBranch,
  getDefaultBranch,
  hasUnpushedCommits,
} from '../../utils/git.js'
import { archiveRemoteSession, teleportToRemote } from '../../utils/teleport.js'
import { githubPrSubscribe } from './githubPrSubscribe.js'

type Phase = 'checking' | 'spawning' | 'subscribing'

const PHASE_MESSAGE: Record<Phase, string> = {
  checking: 'Detecting open PR for current branch…',
  spawning: 'Spawning remote Claude Code session…',
  subscribing: 'Turning on autofix…',
}

type AutofixPrResult =
  | 'on_default_branch'
  | 'not_eligible'
  | 'gh_not_found'
  | 'gh_failed'
  | 'no_open_pr'
  | 'pr_not_open'
  | 'bad_pr_url'
  | 'session_create_failed'
  | 'success'
  | 'cancelled'
  | 'exception'

function defaultPrompt(owner: string, repo: string, number: number): string {
  return `You're monitoring PR #${number} in ${owner}/${repo}. When CI failures or review comments arrive as notifications, investigate and push fixes directly to the PR branch. Start by checking the current PR status.`
}

function resultMeta(
  result: AutofixPrResult,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return result as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

function AutofixPr({
  onDone,
  context,
  prompt,
}: {
  onDone: Parameters<LocalJSXCommandCall>[0]
  context: Parameters<LocalJSXCommandCall>[1]
  prompt: string
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('checking')
  const [prInfo, setPrInfo] = useState<{ ref: string; url: string } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    logEvent('tengu_autofix_pr_started', {})
    void run()

    async function run(): Promise<void> {
      const fail = (message: string, result: AutofixPrResult): void => {
        if (cancelledRef.current) return
        logEvent('tengu_autofix_pr_result', { result: resultMeta(result) })
        setError(`Autofix PR failed: ${message}`)
      }

      try {
        const [branch, defaultBranch, eligibility, unpushed] = await Promise.all(
          [
            getBranch(),
            getDefaultBranch(),
            checkRemoteAgentEligibility({ skipBundle: true }),
            hasUnpushedCommits(),
          ],
        )

        if (branch === defaultBranch) {
          return fail(
            `cannot run on the default branch (${defaultBranch}). Check out a feature branch first.`,
            'on_default_branch',
          )
        }

        if (!eligibility.eligible) {
          const reasons = eligibility.errors
            .map(formatPreconditionError)
            .join('\n')
          return fail(
            `cannot launch remote session —\n${reasons}`,
            'not_eligible',
          )
        }

        const { stdout, code, error: ghError } = await execFileNoThrow(
          'gh',
          ['pr', 'view', '--json', 'number,state,url'],
          {
            timeout: 10_000,
            preserveOutputOnError: true,
            abortSignal: context.abortController.signal,
          },
        )

        if (code !== 0 || !stdout.trim()) {
          if (ghError?.includes('ENOENT')) {
            return fail('gh CLI is required but not found.', 'gh_not_found')
          }
          if (ghError) {
            return fail(`gh pr view failed: ${ghError}`, 'gh_failed')
          }
          return fail(
            `no open PR found for branch "${branch}". Create a PR first, then retry.`,
            'no_open_pr',
          )
        }

        let number: number
        let owner: string
        let repo: string
        let prUrl: string
        try {
          const parsed = JSON.parse(stdout) as {
            number: number
            state: string
            url: string
          }
          if (parsed.state === 'MERGED' || parsed.state === 'CLOSED') {
            return fail(
              `PR #${parsed.number} is ${parsed.state.toLowerCase()}. Autofix requires an open PR.`,
              'pr_not_open',
            )
          }
          const match = parsed.url.match(/\/([^/]+)\/([^/]+)\/pull\//)
          if (!match || !match[1] || !match[2]) {
            return fail(
              `unexpected PR URL format: ${parsed.url}`,
              'bad_pr_url',
            )
          }
          number = parsed.number
          owner = match[1]
          repo = match[2]
          prUrl = parsed.url
        } catch {
          return fail(
            `no open PR found for branch "${branch}". Create a PR first, then retry.`,
            'no_open_pr',
          )
        }

        if (cancelledRef.current) return
        setPrInfo({ ref: `${owner}/${repo}#${number}`, url: prUrl })
        setPhase('spawning')

        const initialMessage = prompt || defaultPrompt(owner, repo, number)
        const session = await teleportToRemote({
          initialMessage,
          source: 'autofix_pr',
          branchName: branch,
          reuseOutcomeBranch: branch,
          title: `Autofix PR: ${owner}/${repo}#${number} (${branch})`,
          useDefaultEnvironment: true,
          skipBundle: true,
          signal: context.abortController.signal,
          githubPr: { owner, repo, number },
        })

        if (!session) {
          return fail('remote session creation failed.', 'session_create_failed')
        }

        sessionIdRef.current = session.id
        if (cancelledRef.current) {
          void archiveRemoteSession(session.id)
          return
        }

        setPhase('subscribing')
        const subscribed = await githubPrSubscribe(
          session.id,
          `${owner}/${repo}`,
          number,
        )

        if (cancelledRef.current) return

        registerRemoteAgentTask({
          remoteTaskType: 'autofix-pr',
          session: { id: session.id, title: session.title },
          command: initialMessage,
          isLongRunning: true,
          remoteTaskMetadata: { owner, repo, prNumber: number },
          context: {
            abortController: new AbortController(),
            getAppState: context.getAppState,
            setAppState: context.setAppState,
          },
        })

        const sessionUrl = getRemoteSessionUrl(session.id)
        const warnings: string[] = []
        if (!subscribed) {
          warnings.push('WARNING: Failed to turn on autofix for this PR')
        }
        if (unpushed) {
          warnings.push(
            'WARNING: You have unpushed local commits, run git push so the remote session sees them',
          )
        }
        const warningBlock =
          warnings.length > 0 ? `\n${warnings.join('\n')}` : ''
        sessionIdRef.current = null
        logEvent('tengu_autofix_pr_result', { result: resultMeta('success') })
        onDone(
          `Spawned remote autofix PR session on ${branch} (PR #${number})${warningBlock}\n  ${figures.arrowRight} ${sessionUrl}`,
        )
      } catch (err) {
        fail(errorMessage(err), 'exception')
      }
    }

    return () => {
      cancelledRef.current = true
      if (sessionIdRef.current) {
        void archiveRemoteSession(sessionIdRef.current)
      }
    }
  }, [onDone, context, prompt])

  function handleCancel(): void {
    if (error) {
      onDone(error)
      return
    }
    cancelledRef.current = true
    logEvent('tengu_autofix_pr_result', { result: resultMeta('cancelled') })
    context.abortController.abort()
    onDone('Autofix PR cancelled')
  }

  useKeybindings(
    {
      'confirm:yes': () => {
        if (error) onDone(error)
      },
    },
    { context: 'Confirmation', isActive: error !== null },
  )

  return (
    <Dialog
      title="Autofix PR"
      subtitle="Spawn a remote Claude Code session that monitors and autofixes the current PR"
      onCancel={handleCancel}
      hideInputGuide
    >
      <Box flexDirection="column" gap={1} marginBottom={1}>
        {error ? (
          <>
            <Text color="error">{error}</Text>
            <Text dimColor>
              <KeyboardShortcutHint shortcut="Esc/Enter" action="close" />
            </Text>
          </>
        ) : (
          <>
            <LoadingState message={PHASE_MESSAGE[phase]} />
            {prInfo && (
              <Text dimColor>
                PR: <Link url={prInfo.url}>{prInfo.ref}</Link>
              </Text>
            )}
            <Text dimColor>Esc to cancel</Text>
          </>
        )}
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  return <AutofixPr onDone={onDone} context={context} prompt={args.trim()} />
}
