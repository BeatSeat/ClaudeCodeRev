import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { isUltrareviewEnabled } from './review/ultrareviewEnabled.js'

// Legal wants the explicit surface name plus a docs link visible before the
// user triggers, so the description carries "Claude Code on the web" + URL.
export const CCR_TERMS_URL =
  'https://code.claude.com/docs/en/claude-code-on-the-web'

// Official 2.1.186: /review uses the same review engine as /code-review medium.
// With a PR number, we generate a structured code-review prompt that scopes
// to the PR diff and follows the medium-effort review pipeline.
const LOCAL_REVIEW_PROMPT = (prNumber: string, extraArgs = '') => `Review target: GitHub pull request \`${prNumber}\`.

Gather this target's diff with (instead of any local \`git diff\`):
1. \`gh pr view ${prNumber} --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels\` for context
2. \`gh pr diff ${prNumber}\` for the unified diff

The PR's diff is the only review scope \u2014 local working-tree changes are out of scope. When an angle needs surrounding code, Read the files in this checkout if it matches the PR's branch, otherwise fetch file contents via \`gh\`.
${extraArgs ? `
Additional instructions from the user: ${extraArgs}
` : ''}

## Present the review

Provide a readable review: a 2-3 sentence overview of what the PR does, then the findings most-severe first as \`file:line \u2014 summary (failure scenario)\`, or a note that nothing needs changing.

Review scope:
- **Correctness**: logic errors, edge cases, null derefs, race conditions
- **Security**: injection, auth bypass, unsafe deserialization
- **Robustness**: error handling, silent failures, resource leaks
- **Maintainability**: naming, duplication, dead code, missing abstractions
- **Conventions**: match surrounding code style and project patterns

Keep the review focused and actionable. Only flag issues a maintainer would act on.
`

const LOCAL_REVIEW_NO_ARGS_PROMPT = `Run \`gh pr list\` to show the open pull requests, then ask the user which one to review (\`/review <number>\`).
`

const review: Command = {
  type: 'prompt',
  name: 'review',
  description: 'Review a GitHub pull request; for your working diff use /code-review',
  argumentHint: '[pr number]',
  effort: 'medium',
  progressMessage: 'reviewing pull request',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const [first = '', ...rest] = args.trim().split(/\s+/)
    const prNumber = first.replaceAll('`', '').replace(/^#/, '')
    // Official 2.1.186: when a PR number is provided, use the structured
    // code-review engine prompt at medium effort; otherwise show how to pick one.
    const text = prNumber
      ? LOCAL_REVIEW_PROMPT(prNumber, rest.join(' '))
      : LOCAL_REVIEW_NO_ARGS_PROMPT
    return [{ type: 'text', text }]
  },
}

// /ultrareview is the ONLY entry point to the remote bughunter path —
// /review stays purely local. Official 2.1.108 jQK always confirms launch.
const ultrareview: Command = {
  type: 'local-jsx',
  name: 'ultrareview',
  description: `~10–20 min · Finds and verifies bugs in your branch. Runs in Claude Code on the web. See ${CCR_TERMS_URL}`,
  isEnabled: () => isUltrareviewEnabled(),
  load: () => import('./review/ultrareviewCommand.js'),
}

export default review
export { ultrareview }
