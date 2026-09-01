// Official 2.1.129 (G33): kairos autonomous-loop module (bundle export module `eBH`).
//
// Drives the autonomous "/loop" tick: on each scheduled wakeup it resolves the
// tick prompt to inject, based on whether the scheduled `prompt` is an
// autonomous-loop sentinel, a loop.md (loop-tasks file) sentinel, or the
// default. It also owns the cross-session **persistence** variant (the 2.1.129
// delta): the preamble switches between a "stop when quiet" (default) and a
// "keep the loop alive" (persistent) framing, selected by the
// CLAUDE_CODE_LOOP_PERSISTENT env / tengu_kairos_loop_persistent gate, and the
// "newly blocked on a decision ... ending the loop" notification suffix is
// emitted when the loop can't move without the user.
//
// The whole base module (loop-file sentinels + default preamble + tick
// resolvers) is restored here alongside the persistent delta, because the
// persistent functions are woven into the base module (shared export table,
// sentinels and preambles).

import { readFileSync } from 'fs'
import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { MONITOR_TOOL_NAME } from '../tools/MonitorTool/prompt.js'
import {
  isPushWhenClaudeDecidesEnabled,
  PUSH_NOTIFICATION_TOOL_NAME,
} from '../tools/PushNotificationTool/prompt.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode, isFsInaccessible } from './errors.js'

// Tool / sentinel constants. SCHEDULE_WAKEUP_TOOL_NAME and the autonomous-loop
// sentinels have no existing tree home (the ScheduleWakeup tool module is not
// restored in this hop), so they are defined here at their exact bundle values.
const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'
const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop>>'
const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = '<<autonomous-loop-dynamic>>'

// loop.md (loop-tasks file) sentinels, the truncate cap, and the "loop.md
// absent" delivery marker (bundle JaK) used to track that we already emitted
// the preamble for a loop.md-less tick.
export const LOOP_FILE_SENTINEL = '<<loop.md>>'
export const LOOP_FILE_DYNAMIC_SENTINEL = '<<loop.md-dynamic>>'
const LOOP_MD_MAX_BYTES = 25000
const AUTONOMOUS_PREAMBLE_MARKER = '__autonomous_preamble__'

// The autonomous-loop preamble. `AUTONOMOUS_LOOP_PREAMBLE` mirrors the bundle
// init (which assigns it to the default preamble at module-load time).
const DEFAULT_AUTONOMOUS_LOOP_PREAMBLE = `# Autonomous loop check

You're being invoked on a timer while the user is away or occupied. The point is to keep work moving forward without the user driving every step \u2014 finishing things they started, maintaining PRs they're building, catching problems before they come back to find them. You're a steward, not an initiator. The user set you loose on their work, and the value you provide comes from reliably advancing things they've already set in motion, not from finding new things to do.

The key tension to navigate: the user trusts you enough to run autonomously, but that trust is easily lost. Acting on what the conversation already established is safe and valuable. Inventing new work or making irreversible changes without clear authorization erodes trust fast. When you're unsure whether something falls into "continuing established work" or "inventing new work," lean toward the former only when the transcript provides clear evidence the user wanted it done. If you find yourself reaching for justifications about why a push is probably fine, that's a signal to wait.

## What to act on

The current conversation is your highest-signal source \u2014 re-read the transcript above, since everything there is something the user was actively engaged with. The strongest signal is an in-progress PR you've been building together: review comments to address and resolve, failing CI checks to diagnose (and re-enqueue if they're flakes), merge conflicts to fix. The goal is to get the PR into a state where it's ready to merge pending only human review \u2014 the user shouldn't come back to find a PR blocked on things you could have handled. After that, look for unfinished implementation where the last exchange left something half-done, and explicit "I'll also..." or "next I'll..." commitments the conversation made and didn't honor. Weaker but still real: dangling questions you could now answer, verification steps that were skipped, edge cases that were mentioned but not handled, and natural continuations that don't require new decisions.

If you find anything in this category, act on it \u2014 actually do the work, don't describe what could be done. Run the tests, don't say "you could run the tests." The whole point of autonomous operation is that work gets done while the user is away.

When the conversation transcript has nothing left, the current branch's pull/merge request on the user's SCM is the next-best place to look. This is maintenance work \u2014 valuable, but lower priority than continuing the user's active work. Find the PR/MR for the current branch via the SCM's CLI, then check three things: CI status, unresolved review threads, and whether the branch has fallen behind the base. For failing CI, pull the failing job's logs and diagnose before acting \u2014 flaky-shaped failures (timeout, runner died, transient network) can be re-enqueued; real failures need a reproduction and a minimal fix. For unresolved review threads, fetch the comment, address the feedback, push, and resolve the thread via, for example, the GitHub GraphQL \`resolveReviewThread\` mutation (or the equivalent for whichever SCM the project uses). Before pushing anything, check whether someone else has pushed to the branch while you were working \u2014 if so, rebase (don't merge) to keep history clean.

When CI is green, threads are clear, and there's idle time, sweeping the branch for issues is a good use of that time \u2014 bug-hunt or simplification passes catch problems before reviewers do, saving everyone a round-trip.

If everything is genuinely quiet \u2014 no conversation work, no PR maintenance \u2014 say so in one sentence and stop. No summary of what you checked, no list of what you might do later. The user will see your message in the transcript when they come back; three consecutive "nothing to do" results means you should scale back to a quick CI check and stop, not narrate.

## Repeated invocations

If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting \u2014 the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, things are quiet \u2014 do one quick CI/threads check and stop in a single line. Repeated "nothing to do" messages clutter the transcript and waste the user's attention when they come back to review.

Read and analyze freely \u2014 understanding the state of things has no blast radius. Make edits and run tests when you're confident they continue established work. Commit and push only when you're clearly continuing something the user authorized, or when the work pattern makes the intent obvious \u2014 like fixing CI on a PR you've been building together.
`

// The persistent-variant preamble ("keep the loop alive"), the 2.1.129 delta.
const PERSISTENT_AUTONOMOUS_LOOP_PREAMBLE = `# Autonomous loop check

You're being invoked on a timer while the user is away or occupied. The point is to keep work moving forward without the user driving every step \u2014 finishing things they started, maintaining PRs they're building, catching problems before they come back to find them, and following through on the *spirit* of the task they gave you, not just its literal scope. The user set you loose on their work, and the value you provide comes from reliably advancing things they've already set in motion.

The key tension to navigate: the user trusts you enough to run autonomously, but that trust is easily lost. Acting on what the conversation already established is safe and valuable. For irreversible actions (push, delete, send), require clear authorization in the transcript or use a reversible alternative (a draft, a local commit, a queued message). For reversible actions (edits, tests, drafts, exploration), bias toward acting \u2014 the cost of an unneeded local edit is near zero, and the cost of a stalled loop is high. When you're unsure whether something falls into "continuing established work" or "inventing new work," lean toward continuing whenever the transcript gives you any reasonable thread to pull on.

## What to act on

The current conversation is your highest-signal source \u2014 re-read the transcript above, since everything there is something the user was actively engaged with. The strongest signal is an in-progress PR you've been building together: review comments to address and resolve, failing CI checks to diagnose (and re-enqueue if they're flakes), merge conflicts to fix. The goal is to get the PR into a state where it's ready to merge pending only human review \u2014 the user shouldn't come back to find a PR blocked on things you could have handled. After that, look for unfinished implementation where the last exchange left something half-done, and explicit "I'll also..." or "next I'll..." commitments the conversation made and didn't honor. Weaker but still real: dangling questions you could now answer, verification steps that were skipped, edge cases that were mentioned but not handled, and natural continuations that don't require new decisions.

If you find anything in this category, act on it \u2014 actually do the work, don't describe what could be done. Run the tests, don't say "you could run the tests." The whole point of autonomous operation is that work gets done while the user is away.

When the conversation transcript has nothing left, the current branch's pull/merge request on the user's SCM is the next-best place to look. This is maintenance work \u2014 valuable, but lower priority than continuing the user's active work. Find the PR/MR for the current branch via the SCM's CLI, then check three things: CI status, unresolved review threads, and whether the branch has fallen behind the base. For failing CI, pull the failing job's logs and diagnose before acting \u2014 flaky-shaped failures (timeout, runner died, transient network) can be re-enqueued; real failures need a reproduction and a minimal fix. For unresolved review threads, fetch the comment, address the feedback, push, and resolve the thread via, for example, the GitHub GraphQL \`resolveReviewThread\` mutation (or the equivalent for whichever SCM the project uses). Before pushing anything, check whether someone else has pushed to the branch while you were working \u2014 if so, rebase (don't merge) to keep history clean.

When CI is green, threads are clear, and there's idle time, sweeping the branch for issues is a good use of that time \u2014 bug-hunt or simplification passes catch problems before reviewers do, saving everyone a round-trip.

If everything is genuinely quiet \u2014 no conversation work, no PR maintenance \u2014 say so in one sentence and keep the loop alive. Before stopping, broaden once: re-read the original task framing, check whether earlier ticks deferred anything ("I'll wait for X"), and look at sibling PRs/branches the user owns. Persistence is the point of autonomous mode. Only stop if the original task is provably complete or the user said to stop. (Pacing \u2014 how long to wait before the next tick \u2014 is handled by the per-mode reminder appended to this preamble; don't try to manage delay from here.)

## Repeated invocations

If you see earlier autonomous checks in this conversation, adjust your scope accordingly. If a previous check left a question the user hasn't answered, the cost of acting depends on reversibility: for reversible actions (local edits, running tests), make your best call and proceed; for irreversible ones (pushing, deleting, sending), keep waiting \u2014 the cost of acting wrongly on something irreversible is much higher than the cost of waiting one more cycle. If three or more consecutive checks have found nothing actionable, broaden scope once before considering stopping \u2014 re-read the original task, check sibling work, look for verification or polish steps that were skipped. A loop that quits the moment work goes quiet is less useful than one that waits.

Read and analyze freely \u2014 understanding the state of things has no blast radius. Make edits and run tests when you're confident they continue established work. Commit and push only when you're clearly continuing something the user authorized, or when the work pattern makes the intent obvious \u2014 like fixing CI on a PR you've been building together.
`

export const AUTONOMOUS_LOOP_PREAMBLE = DEFAULT_AUTONOMOUS_LOOP_PREAMBLE

// The dynamic-pacing reminder, appended to the dynamic tick prompts (bundle
// assigns it at module init; the ScheduleWakeup prompt body is the module's
// other dependency and is not part of this module).
let dynamicPacingReminder = `

If a ${MONITOR_TOOL_NAME} is armed (check ${TASK_LIST_TOOL_NAME}), keep \`delaySeconds\` at 1200\u20131800s \u2014 the ${MONITOR_TOOL_NAME} is the wake signal and this is only the fallback heartbeat. If you were woken by a \`<task-notification>\`, handle the event before rescheduling. To stop the loop, also ${TASK_STOP_TOOL_NAME} the monitor (use ${TASK_LIST_TOOL_NAME} to find its task ID if no longer in context).`

// Per-session delivery state: whether the autonomous preamble has already been
// delivered, and the last loop.md content we delivered (so we don't re-emit a
// large loop-file body on every fire).
let autonomousPreambleDelivered = false
let lastDeliveredLoopFileContent: string | null = null

// ---------------------------------------------------------------------------
// 2.1.129 persistent delta (the four astdiff-Added functions).
// ---------------------------------------------------------------------------

/**
 * Bundle Ae$(). True when the persistent (keep-the-loop-alive) preamble is
 * active -- forced on by CLAUDE_CODE_LOOP_PERSISTENT, otherwise the
 * tengu_kairos_loop_persistent gate (default off).
 */
export function isLoopPersistentPreambleEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_LOOP_PERSISTENT)) return true
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_loop_persistent', false)
}

/**
 * Bundle Oz6(). Picks the persistent vs default preamble.
 */
export function getAutonomousLoopPreamble(): string {
  return isLoopPersistentPreambleEnabled()
    ? PERSISTENT_AUTONOMOUS_LOOP_PREAMBLE
    : DEFAULT_AUTONOMOUS_LOOP_PREAMBLE
}

/**
 * Bundle Mz6(). Fires the "activated" telemetry once when the loop actually
 * runs (called from the autonomous and loop-file resolvers).
 */
export function logAutonomousLoopActivation(): void {
  logEvent('tengu_kairos_loop_persistent_activated', {
    variant: isLoopPersistentPreambleEnabled(),
  })
}

/**
 * Bundle jY$(). The "newly blocked on a decision ..." notification suffix,
 * emitted (via PushNotification) when the loop can't move without the user.
 * `dynamic` selects the "third straight tick" phrasing for dynamically-paced
 * ticks. Empty string when kairos push notifications are not enabled.
 */
function getAutonomousLoopBlockedSuffix(dynamic = false): string {
  if (!isPushWhenClaudeDecidesEnabled()) return ''
  const blockedReason = !dynamic && isLoopPersistentPreambleEnabled()
    ? "newly blocked on a decision you won't make alone, you're ending the loop"
    : "newly blocked on a decision you won't make alone, third straight tick with nothing to do, you're ending the loop"
  return `

Use ${PUSH_NOTIFICATION_TOOL_NAME} when the loop can't move further without the user, or when something landed that they'd want to act on now: ${blockedReason}, or a major update arrived (CI went red, a review changes the plan). Progress you made yourself isn't a trigger \u2014 the transcript covers that. One ping per state, not per tick.`
}

// ---------------------------------------------------------------------------
// Base autonomous-loop module (loop-file sentinels, preambles, tick resolvers).
// ---------------------------------------------------------------------------

// Bundle PaK(). Default-mode autonomous tick prompt.
function getAutonomousLoopTickPrompt(): string {
  return `# Autonomous loop tick

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically \u2014 do not call ${SCHEDULE_WAKEUP_TOOL_NAME} from this tick.${getAutonomousLoopBlockedSuffix()}`
}

// Bundle Se1(). Dynamic-pacing autonomous tick prompt.
function getDynamicPacingAutonomousTickPrompt(): string {
  return `# Autonomous loop tick (dynamic pacing)

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive, call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${AUTONOMOUS_LOOP_DYNAMIC_SENTINEL}\` \u2014 otherwise the loop ends after this tick.${dynamicPacingReminder}${getAutonomousLoopBlockedSuffix()}`
}

// Bundle Dz6(). The default autonomous-loop prompt gate.
export function isLoopDefaultPromptEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_loop_prompt', false)
}

// Bundle jz6(). True when the scheduled prompt is an autonomous-loop sentinel.
export function isAutonomousLoopSentinel(prompt: string): boolean {
  return prompt === AUTONOMOUS_LOOP_SENTINEL || prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
}

// Bundle WaK(). Resolve an autonomous-loop tick: prepend the preamble the first
// time, then keep firing the tick prompt. Null when the prompt isn't an
// autonomous-loop sentinel or the feature is off.
export function resolveAutonomousLoopFire(prompt: string): string | null {
  if (!isAutonomousLoopSentinel(prompt)) return null
  if (!isLoopDefaultPromptEnabled()) return null
  logAutonomousLoopActivation()
  const tickPrompt =
    prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
      ? getDynamicPacingAutonomousTickPrompt()
      : getAutonomousLoopTickPrompt()
  if (autonomousPreambleDelivered || lastDeliveredLoopFileContent !== null) {
    return tickPrompt
  }
  autonomousPreambleDelivered = true
  return `${getAutonomousLoopPreamble()}

---

${tickPrompt}`
}

// Bundle Re1(). loop.md present, default pacing.
function getLoopFileTickPrompt(): string {
  return `# /loop tick \u2014 loop.md tasks

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically \u2014 do not call ${SCHEDULE_WAKEUP_TOOL_NAME} from this tick.${getAutonomousLoopBlockedSuffix(true)}`
}

// Bundle Ce1(). loop.md present, dynamic pacing.
function getDynamicLoopFileTickPrompt(): string {
  return `# /loop tick \u2014 loop.md tasks (dynamic pacing)

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive, call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` \u2014 otherwise the loop ends after this tick.${dynamicPacingReminder}${getAutonomousLoopBlockedSuffix(true)}`
}

// Bundle be1(). loop.md absent, dynamic pacing.
function getLoopFileAbsentTickPrompt(): string {
  return `# /loop tick \u2014 loop.md absent (dynamic pacing)

loop.md is not currently present. Run the autonomous check using the loop instructions established earlier in this conversation.

You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive \u2014 and to pick up loop.md if it is recreated \u2014 call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` \u2014 otherwise the loop ends after this tick.${dynamicPacingReminder}${getAutonomousLoopBlockedSuffix()}`
}

// Bundle xe1(). Truncate an oversized loop.md to LOOP_MD_MAX_BYTES on a
// newline boundary.
function truncateLoopMdContent(content: string): string {
  if (content.length <= LOOP_MD_MAX_BYTES) return content
  const newlineIndex = content.lastIndexOf('\n', LOOP_MD_MAX_BYTES)
  return `${content.slice(0, newlineIndex > 0 ? newlineIndex : LOOP_MD_MAX_BYTES)}

> WARNING: loop.md was truncated to ${LOOP_MD_MAX_BYTES} bytes. Keep the task list concise.`
}

// Bundle ZaK(). Read loop.md from the project .claude dir, falling back to the
// global Claude config home (the cross-session persistence path).
export function readLoopFile(): { path: string; content: string } | null {
  const candidatePaths = [
    join(getProjectRoot(), '.claude', 'loop.md'),
    join(getClaudeConfigHomeDir(), 'loop.md'),
  ]
  for (const candidatePath of candidatePaths) {
    let raw: string
    try {
      raw = readFileSync(candidatePath, 'utf-8')
    } catch (error) {
      if (isFsInaccessible(error) || getErrnoCode(error) === 'EISDIR') continue
      throw error
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    return { path: candidatePath, content: truncateLoopMdContent(trimmed) }
  }
  return null
}

// Bundle Xz6(). True when the scheduled prompt is a loop.md sentinel.
export function isLoopFileSentinel(prompt: string): boolean {
  return prompt === LOOP_FILE_SENTINEL || prompt === LOOP_FILE_DYNAMIC_SENTINEL
}

// Bundle TaK(). Resolve a loop.md (loop-tasks file) tick: emit the loop-file
// body once, then keep firing the (loop.md present/absent) tick prompt.
export function resolveLoopFileFire(prompt: string): string | null {
  if (!isLoopFileSentinel(prompt)) return null
  if (!isLoopDefaultPromptEnabled()) return null
  const dynamic = prompt === LOOP_FILE_DYNAMIC_SENTINEL
  const loopFile = readLoopFile()
  if (loopFile) {
    const tickBody = dynamic
      ? getDynamicLoopFileTickPrompt()
      : getLoopFileTickPrompt()
    if (lastDeliveredLoopFileContent === loopFile.content) return tickBody
    lastDeliveredLoopFileContent = loopFile.content
    return `# /loop tick \u2014 tasks from ${loopFile.path}

The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).

---

${loopFile.content}

---

${tickBody}`
  }
  logAutonomousLoopActivation()
  const tickPrompt = dynamic
    ? getLoopFileAbsentTickPrompt()
    : getAutonomousLoopTickPrompt()
  if (
    lastDeliveredLoopFileContent === AUTONOMOUS_PREAMBLE_MARKER ||
    autonomousPreambleDelivered
  ) {
    return tickPrompt
  }
  lastDeliveredLoopFileContent = AUTONOMOUS_PREAMBLE_MARKER
  autonomousPreambleDelivered = true
  return `${getAutonomousLoopPreamble()}

---

${tickPrompt}`
}

// Bundle ue1(). True when the prompt is any default-prompt sentinel (autonomous
// or loop-file).
export function isLoopDefaultSentinel(prompt: string): boolean {
  return isAutonomousLoopSentinel(prompt) || isLoopFileSentinel(prompt)
}

// Bundle me1(). The top-level resolver: autonomous, then loop-file, else the
// original prompt unchanged.
export function resolveLoopDefaultFire(prompt: string): string | null {
  return resolveAutonomousLoopFire(prompt) ?? resolveLoopFileFire(prompt) ?? prompt
}

// Bundle pe1(). Reset the per-session delivery state (called on compact so the
// preamble re-delivers in a fresh context).
export function resetAutonomousLoopDelivered(): void {
  autonomousPreambleDelivered = false
  lastDeliveredLoopFileContent = null
}
