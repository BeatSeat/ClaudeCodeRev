import { randomUUID } from 'crypto'
import { join, resolve } from 'path'
import ts from 'typescript'
import vm from 'vm'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { generateTaskId } from '../../Task.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { isENOENT, isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import { getProjectDirsUpToHome } from '../../utils/markdownConfigLoader.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import type { PermissionBehavior } from '../../types/permissions.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import type { SettingSource } from '../../utils/settings/constants.js'
import {
  areWorkflowsDisabledByKillSwitch,
  isWorkflowsEnabled,
} from '../../utils/workflows/enabled.js'
import { getBundledWorkflows } from './bundled/index.js'
import {
  MAX_WORKFLOW_SCRIPT_BYTES,
  WORKFLOW_SEARCH_HINT,
  WORKFLOW_TOOL_NAME,
} from './constants.js'
import { recordWorkflowUsageConsent } from './usageConsent.js'
import memoize from 'lodash-es/memoize.js'

/** Official 2.1.153 reserved meta keys (`TW_`). */
const RESERVED_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Official 2.1.153 `Rm`. */
function isUncWorkflowPath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

export type WorkflowPhase = {
  title: string
  detail?: string
  model?: string
}

export type WorkflowMeta = {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}

export type ParsedWorkflowScript =
  | { meta: WorkflowMeta; scriptBody: string }
  | { error: string }

export type DiscoveredWorkflow = {
  source: 'built-in' | 'plugin' | SettingSource
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
  script: string
  filePath?: string
  plugin?: string
  pluginManifest?: unknown
}

export type ResolvedWorkflow =
  | {
      script: string
      resolvedScriptPath?: string
      source?: DiscoveredWorkflow['source']
    }
  | { error: string }

type WorkflowInput = {
  script?: string
  name?: string
  description?: string
  title?: string
  args?: unknown
  scriptPath?: string
  resumeFromRunId?: string
}

type WorkflowOutput = {
  status: 'async_launched' | 'remote_launched'
  taskId: string
  runId?: string
  summary?: string
  transcriptDir?: string
  scriptPath?: string
  sessionUrl?: string
  warning?: string
  error?: string
}

/**
 * Official 2.1.153 `UB6` (i2_/c2_/n2_ are empty; l2_ = `'worktree'`; EGH = ▸).
 */
const WORKFLOW_PROMPT = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the "workflow" or "workflows" keyword (you'll see a system-reminder confirming it).
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can include "workflow" in a future message to skip the ask.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify (example below)
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

Every invocation persists its script to a file under the session directory and returns the path in the tool result. To iterate on a workflow, edit that file with Write/Edit and re-invoke Workflow with \`{scriptPath: "<path>"}\` instead of resending the full script.

Every script must begin with \`export const meta = {...}\`:
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
    phases: [                                            // one entry per phase() call
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // script body starts here — use agent()/parallel()/pipeline()/phase()/log()
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
  ...

The \`meta\` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: \`name\`, \`description\`. Optional: \`whenToUse\` (shown in the workflow list), \`phases\`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add \`model\` to a phase entry when that phase uses a specific model override.

Script body hooks:
- agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, isolation?: 'worktree', agentType?: string}): Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object — no parsing needed. Returns null if the user skips the agent mid-run (filter with .filter(Boolean)). opts.label overrides the display label. opts.phase explicitly assigns this agent to a progress group (use this inside pipeline()/parallel() stages to avoid races on the global phase() state — same phase string → same group box). opts.model overrides the model for this agent call. Default to omitting it — the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you're highly confident a different tier fits the task; when unsure, omit. opts.isolation: 'worktree' runs the agent in a fresh git worktree — EXPENSIVE (~200-500ms setup + disk per agent), use ONLY when agents mutate files in parallel and would otherwise conflict; the worktree is auto-removed if unchanged. opts.agentType uses a custom subagent type (e.g. 'Explore', 'code-reviewer') instead of the default workflow subagent — resolved from the same registry as the Agent tool; composes with schema (the custom agent's system prompt gets a StructuredOutput instruction appended).
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) — use originalItem/index in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to \`null\` and skips its remaining stages.
- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to \`null\` in the result array — the call itself never rejects, so \`.filter(Boolean)\` before using the results. Use ONLY when you genuinely need all results together.
- log(message: string): void — emit a progress message to the user (shown as a narrator line above the progress tree)
- phase(title: string): void — start a new phase; subsequent agent() calls are grouped under this title in the progress display
- args: any — the value passed as Workflow's \`args\` input (undefined if not provided). Use this to parameterize named workflows — e.g. pass a research question, target path, or config object directly instead of via a side-channel file.
- budget: {total: number|null, spent(): number, remaining(): number} — the turn's token target from the user's "+500k"-style directive. \`budget.total\` is null if no target was set. \`budget.spent()\` returns output tokens spent this turn across the main loop and all workflows — the pool is shared, not per-workflow. \`budget.remaining()\` returns \`max(0, total - spent())\`, or \`Infinity\` if no target. The target is a HARD ceiling, not advisory: once \`spent()\` reaches \`total\`, further \`agent()\` calls throw. Use for dynamic loops: \`while (budget.total && budget.remaining() > 50_000) { ... }\`, or static scaling: \`const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5\`.
- workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any> — run another workflow inline as a sub-step and return whatever it returns. Pass a name to invoke a saved workflow (same registry as {name: "..."}), or {scriptPath} to run a script file you Wrote earlier. The child shares this run's concurrency cap, agent counter, abort signal, and token budget — its agents appear under a "▸ name" group in /workflows and its tokens count toward budget.spent(). The args param becomes the child's \`args\` global. Nesting is one level only: workflow() inside a child throws. Throws on unknown name / unreadable scriptPath / child syntax error; catch to handle gracefully.

Subagents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option — validation happens at the tool-call layer so the model retries on mismatch.

Workflow agents can reach all session-connected MCP tools via ToolSearch — schemas load on demand per agent. Caveat: interactively-authenticated MCP servers (e.g. claude.ai) may be absent in headless/cron runs.

The script body runs in an async context — use await directly. Standard JS built-ins (JSON, Math, Array, etc.) are available — EXCEPT \`Date.now()\`/\`Math.random()\`/argless \`new Date()\`, which throw (they would break resume); pass timestamps in via \`args\`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. No filesystem or Node.js API access.

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: pipeline(items, stageA, r => transform([r]).flat(), stageB)
- "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.

Smell test: if you wrote
  const a = await parallel(...)
  const b = transform(a)        // flatten, map, filter — no cross-item dependency
  const c = await parallel(b.map(...))
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow — excess calls queue and run as slots free up. You can still pass 100 items to parallel()/pipeline() and they all complete; only ~10 run at any moment. Total agent count across a workflow's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.

When a barrier IS correct — dedup across all findings before expensive verification:
  const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
  const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
  const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))

Loop-until-count pattern — accumulate to a target:
  const bugs = []
  while (bugs.length < 10) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(\`\${bugs.length}/10 found\`)
  }

Loop-until-budget pattern — scale depth to the user's "+500k" directive. Guard on budget.total: with no target set, remaining() is Infinity and the loop would run straight to the 1000-agent cap.
  const bugs = []
  while (budget.total && budget.remaining() > 50_000) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(\`\${bugs.length} found, \${Math.round(budget.remaining()/1000)}k remaining\`)
  }

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):
  const seen = new Set(), confirmed = []
  let dry = 0
  while (dry < 2) {                                              // loop-until-dry
    const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
      agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
    const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
    if (!fresh.length) { dry++; continue }
    dry = 0; fresh.forEach(b => seen.add(key(b)))
    const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
      parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
        agent(\`Judge "\${b.desc}" via the \${lens} lens — real?\`, {phase: 'Verify', schema: VERDICT})))
        .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
    confirmed.push(...judged.filter(v => v.real).map(v => v.b))
  }
  return confirmed
  // dedup vs \`seen\`, NOT \`confirmed\` — else judge-rejected findings reappear every round and it never converges.

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
    const votes = await parallel(Array.from({length: 3}, () => () =>
      agent(\`Try to refute: \${claim}. Default to refuted=true if uncertain.\`, {schema: VERDICT})))
    const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.
- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won't find everything.
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), \`log()\` what was dropped — silent truncation reads as "covered everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).

Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## Resume

The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. Date.now()/Math.random()/new Date() are unavailable in scripts (they would break this) — stamp results after the workflow returns, or pass timestamps via args. Fallback when no journal is available: Read agent-<id>.jsonl files in the transcript directory and hand-author a continuation script.
`

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      script: z
        .string()
        .max(MAX_WORKFLOW_SCRIPT_BYTES)
        .optional()
        .describe(
          'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.',
        ),
      description: z
        .string()
        .optional()
        .describe(
          "Ignored — set the workflow description in the script's `meta` block.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Ignored — set the workflow title in the script's `meta` block.",
        ),
      args: z
        .unknown()
        .optional()
        .describe(
          'Optional input value exposed to the script as the global `args`. Use for parameterized named workflows (e.g. a research question).',
        ),
      scriptPath: z
        .string()
        .optional()
        .describe(
          'Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.',
        ),
      resumeFromRunId: z
        .string()
        .regex(/^wf_[a-z0-9-]{6,}$/)
        .optional()
        .describe(
          `Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (${TASK_STOP_TOOL_NAME}) before resuming.`,
        ),
    })
    .refine(input => input.script || input.name || input.scriptPath, {
      message: 'Must provide script, name, or scriptPath',
    }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['async_launched', 'remote_launched']),
    taskId: z.string(),
    runId: z
      .string()
      .optional()
      .describe(
        'Local workflow run identifier for resumeFromRunId. Absent for remote_launched (the CCR session URL is the resume handle there) and on transcripts written before this field existed.',
      ),
    summary: z.string().optional(),
    transcriptDir: z
      .string()
      .optional()
      .describe(
        'Directory where subagent transcripts are written during execution',
      ),
    scriptPath: z
      .string()
      .optional()
      .describe(
        'Path to the persisted workflow script for this invocation. Editable via Write/Edit; pass back as `scriptPath` to re-run without resending the script.',
      ),
    sessionUrl: z
      .string()
      .optional()
      .describe('CCR session URL when status is remote_launched'),
    warning: z
      .string()
      .optional()
      .describe(
        'Non-blocking heads-up (e.g. local git state diverges from the pushed branch the remote session will clone)',
      ),
    error: z.string().optional().describe('Set if syntax check failed'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

function asTelemetry(
  value: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

function isLocalWorkflowTask(
  task: unknown,
): task is import('../../tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTaskState {
  return (
    !!task &&
    typeof task === 'object' &&
    'type' in task &&
    (task as { type?: string }).type === 'local_workflow'
  )
}

/** Official 2.1.153 `NW_`. */
function parseWorkflowPhases(value: unknown): WorkflowPhase[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const phases: WorkflowPhase[] = []
  for (const item of value) {
    if (item && typeof item === 'object' && 'title' in item) {
      const { title, detail, model } = item as {
        title: unknown
        detail?: unknown
        model?: unknown
      }
      if (typeof title === 'string') {
        phases.push({
          title,
          detail: typeof detail === 'string' ? detail : undefined,
          model: typeof model === 'string' ? model : undefined,
        })
      }
    }
  }
  return phases.length > 0 ? phases : undefined
}

/** Official 2.1.153 `kW_`. */
function validateWorkflowMeta(
  raw: Record<string, unknown>,
): { meta: WorkflowMeta } | { error: string } {
  const name = raw.name
  if (typeof name !== 'string' || name.length === 0) {
    return { error: 'meta.name must be a non-empty string' }
  }
  const description = raw.description
  if (typeof description !== 'string' || description.length === 0) {
    return { error: 'meta.description must be a non-empty string' }
  }
  const title =
    typeof raw.title === 'string' && raw.title.length > 0
      ? raw.title
      : undefined
  const whenToUse =
    typeof raw.whenToUse === 'string' ? raw.whenToUse : undefined
  return {
    meta: {
      name,
      description,
      title,
      whenToUse,
      phases: parseWorkflowPhases(raw.phases),
    },
  }
}

/** Official 2.1.153 `vq4`. Host parser is TypeScript AST (acorn `Vq4` is not a package dep). */
function evalMetaLiteral(node: ts.Expression): unknown {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
      return (node as ts.StringLiteral).text
    case ts.SyntaxKind.NumericLiteral:
      return Number((node as ts.NumericLiteral).text)
    case ts.SyntaxKind.TrueKeyword:
      return true
    case ts.SyntaxKind.FalseKeyword:
      return false
    case ts.SyntaxKind.NullKeyword:
      return null
    case ts.SyntaxKind.ArrayLiteralExpression: {
      const arr = node as ts.ArrayLiteralExpression
      return arr.elements.map(element => {
        if (element.kind === ts.SyntaxKind.OmittedExpression) {
          throw new Error('sparse arrays not allowed')
        }
        if (ts.isSpreadElement(element)) {
          throw new Error('spread not allowed in meta')
        }
        return evalMetaLiteral(element)
      })
    }
    case ts.SyntaxKind.ObjectLiteralExpression:
      return evalMetaObject(node as ts.ObjectLiteralExpression)
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return (node as ts.NoSubstitutionTemplateLiteral).text
    case ts.SyntaxKind.TemplateExpression: {
      const tpl = node as ts.TemplateExpression
      if (tpl.templateSpans.length > 0) {
        throw new Error('template interpolation not allowed in meta')
      }
      return tpl.head.text
    }
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const unary = node as ts.PrefixUnaryExpression
      if (
        unary.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(unary.operand)
      ) {
        return -Number(unary.operand.text)
      }
      throw new Error('only negative-number unary allowed in meta')
    }
    default:
      throw new Error(
        `non-literal node type in meta: ${ts.SyntaxKind[node.kind]}`,
      )
  }
  throw new Error(`non-literal node type in meta: ${ts.SyntaxKind[node.kind]}`)
}

/** Official 2.1.153 `vW_`. */
function evalMetaKey(name: ts.PropertyName): string {
  if (ts.isIdentifier(name)) {
    const key = name.text
    if (RESERVED_META_KEYS.has(key)) {
      throw new Error(`reserved key name not allowed in meta: ${key}`)
    }
    return key
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    const key = name.text
    if (RESERVED_META_KEYS.has(key)) {
      throw new Error(`reserved key name not allowed in meta: ${key}`)
    }
    return key
  }
  throw new Error(`unsupported key type in meta: ${ts.SyntaxKind[name.kind]}`)
}

/** Official 2.1.153 `kq4`. */
function evalMetaObject(node: ts.ObjectLiteralExpression): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new Error('only plain properties allowed in meta')
    }
    if ('questionToken' in prop && prop.questionToken) {
      throw new Error('only plain properties allowed in meta')
    }
    if (
      ts.isComputedPropertyName(prop.name) ||
      (ts.isIdentifier(prop.name) === false &&
        !ts.isStringLiteral(prop.name) &&
        !ts.isNumericLiteral(prop.name))
    ) {
      if (ts.isComputedPropertyName(prop.name)) {
        throw new Error('computed keys not allowed in meta')
      }
    }
    out[evalMetaKey(prop.name)] = evalMetaLiteral(prop.initializer)
  }
  return out
}

/** Official 2.1.153 `VW_`. */
function isExportConstMeta(stmt: ts.Statement): stmt is ts.VariableStatement {
  if (!ts.isVariableStatement(stmt)) {
    return false
  }
  const exported = stmt.modifiers?.some(
    modifier => modifier.kind === ts.SyntaxKind.ExportKeyword,
  )
  if (!exported) {
    return false
  }
  if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) {
    return false
  }
  if (stmt.declarationList.declarations.length !== 1) {
    return false
  }
  const decl = stmt.declarationList.declarations[0]
  return (
    !!decl &&
    ts.isIdentifier(decl.name) &&
    decl.name.text === 'meta' &&
    !!decl.initializer &&
    ts.isObjectLiteralExpression(decl.initializer)
  )
}

/**
 * Official 2.1.153 `bZ`. Acorn (`Vq4`) is vendored in the bundle, not a
 * package dep — the walk is official; the host parser is TypeScript.
 */
export function parseWorkflowScript(script: string): ParsedWorkflowScript {
  if (script.length > MAX_WORKFLOW_SCRIPT_BYTES) {
    return { error: `Script exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes` }
  }
  let sourceFile: ts.SourceFile
  try {
    sourceFile = ts.createSourceFile(
      'workflow.js',
      script,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    )
  } catch (error) {
    return {
      error: `Script parse error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const first = sourceFile.statements[0]
  if (!first || !isExportConstMeta(first)) {
    return {
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    }
  }
  const init = first.declarationList.declarations[0]!.initializer
  if (!init || !ts.isObjectLiteralExpression(init)) {
    return {
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    }
  }
  let raw: Record<string, unknown>
  try {
    raw = evalMetaObject(init)
  } catch (error) {
    return {
      error: `meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const validated = validateWorkflowMeta(raw)
  if ('error' in validated) {
    return validated
  }
  const scriptBody = script
    .slice(first.end)
    .replace(/^[;\s]*\n/, '')
    .trimStart()
  return { meta: validated.meta, scriptBody }
}

/**
 * Official 2.1.153 `BM$`.
 */
export async function readWorkflowScriptPath(
  scriptPath: string,
): Promise<{ script: string; path: string } | { error: string }> {
  if (isUncWorkflowPath(scriptPath)) {
    return {
      error: `UNC paths are not allowed for workflow scriptPath: ${scriptPath}`,
    }
  }
  const resolved = resolve(getCwd(), scriptPath)
  try {
    const script = await getFsImplementation().readFile(resolved, {
      encoding: 'utf-8',
    })
    if (script.length > MAX_WORKFLOW_SCRIPT_BYTES) {
      return {
        error: `Workflow script file ${resolved} is ${script.length} bytes; max ${MAX_WORKFLOW_SCRIPT_BYTES}`,
      }
    }
    return { script, path: resolved }
  } catch (error) {
    if (isENOENT(error)) {
      return { error: `Workflow script file not found: ${resolved}` }
    }
    return {
      error: `Failed to read workflow script file ${resolved}: ${error}`,
    }
  }
}

/**
 * Official 2.1.153 `g2_` / `U0$`.
 */
function listProjectWorkflowDirs(cwd: string): string[] {
  try {
    return getProjectDirsUpToHome('workflows', cwd)
  } catch (error) {
    if (isFsInaccessible(error)) {
      logForDebugging(
        `loadWorkflowsDir: project-dir walk failed: ${error.code}`,
        { level: 'error' },
      )
      return []
    }
    throw error
  }
}

/**
 * Official 2.1.153 `pK4`.
 */
async function loadWorkflowsFromDir(
  dir: string,
  source: SettingSource,
): Promise<DiscoveredWorkflow[]> {
  const fsImpl = getFsImplementation()
  let entries
  try {
    entries = await fsImpl.readdir(dir)
  } catch {
    return []
  }
  const loaded = await Promise.all(
    entries.map(async entry => {
      if (!(entry.isFile() || entry.isSymbolicLink())) {
        return null
      }
      if (!entry.name.endsWith('.js')) {
        return null
      }
      const filePath = join(dir, entry.name)
      let script: string
      try {
        script = await fsImpl.readFile(filePath, { encoding: 'utf-8' })
      } catch {
        return null
      }
      if (script.length > MAX_WORKFLOW_SCRIPT_BYTES) {
        logForDebugging(
          `Workflow ${filePath} exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes — skipping`,
          { level: 'warn' },
        )
        return null
      }
      const parsed = parseWorkflowScript(script)
      if ('error' in parsed) {
        logForDebugging(
          `Workflow ${filePath} has invalid meta: ${parsed.error} — skipping`,
          { level: 'warn' },
        )
        return null
      }
      return {
        source,
        name: parsed.meta.name,
        description: parsed.meta.description,
        whenToUse: parsed.meta.whenToUse,
        phases: parsed.meta.phases,
        script,
        filePath,
      } satisfies DiscoveredWorkflow
    }),
  )
  return loaded.filter((item): item is DiscoveredWorkflow => item !== null)
}

/**
 * Official 2.1.153 `UK4`.
 */
async function loadDiskWorkflows(cwd: string): Promise<DiscoveredWorkflow[]> {
  const userDir = join(getClaudeConfigHomeDir(), 'workflows')
  const projectDirs = listProjectWorkflowDirs(cwd)
  const [userWorkflows, ...projectWorkflows] = await Promise.all([
    isSettingSourceEnabled('userSettings')
      ? loadWorkflowsFromDir(userDir, 'userSettings')
      : Promise.resolve([]),
    ...(isSettingSourceEnabled('projectSettings')
      ? projectDirs.map(dir => loadWorkflowsFromDir(dir, 'projectSettings'))
      : []),
  ])
  const byName = new Map<string, DiscoveredWorkflow>()
  for (const workflow of userWorkflows) {
    byName.set(workflow.name, workflow)
  }
  for (const group of projectWorkflows) {
    for (const workflow of group) {
      byName.set(workflow.name, workflow)
    }
  }
  return [...byName.values()]
}

/**
 * Official 2.1.153 `QP8` plugin loader is not mounted (DY / CK4 / xK4).
 * Returns [] so `lXH` still composes disk + bundled.
 */
async function loadPluginWorkflows(): Promise<DiscoveredWorkflow[]> {
  return []
}

/**
 * Official 2.1.153 `lXH`.
 */
export const listWorkflows = memoize(async (cwd: string) => {
  const [disk, plugin] = await Promise.all([
    loadDiskWorkflows(cwd),
    loadPluginWorkflows(),
  ])
  const diskNames = new Set(disk.map(item => item.name))
  const pluginOnly = plugin.filter(item => !diskNames.has(item.name))
  const taken = new Set([
    ...diskNames,
    ...pluginOnly.map(item => item.name),
  ])
  const bundled = getBundledWorkflows()
    .filter(item => !taken.has(item.name))
    .map(
      (item): DiscoveredWorkflow => ({
        source: 'built-in',
        name: item.name,
        description: item.description,
        whenToUse: item.whenToUse,
        phases: item.phases,
        script: item.script,
      }),
    )
  return [...bundled, ...pluginOnly, ...disk]
})

/** Official 2.1.153 `F0$`. */
export async function findWorkflowByName(
  name: string,
  cwd: string,
): Promise<DiscoveredWorkflow | undefined> {
  return (await listWorkflows(cwd)).find(item => item.name === name)
}

/**
 * Official 2.1.153 `V74`.
 */
export async function resolveWorkflowInput(
  input: WorkflowInput,
): Promise<ResolvedWorkflow> {
  if (input.scriptPath) {
    if (input.script) {
      return {
        script: input.script,
        resolvedScriptPath: resolve(getCwd(), input.scriptPath),
      }
    }
    const fromDisk = await readWorkflowScriptPath(input.scriptPath)
    if ('error' in fromDisk) {
      return fromDisk
    }
    return { script: fromDisk.script, resolvedScriptPath: fromDisk.path }
  }
  if (input.name) {
    const named = await findWorkflowByName(input.name, getCwd())
    if (!named) {
      const available = (await listWorkflows(getCwd()))
        .map(item => item.name)
        .join(', ')
      return {
        error: `Workflow "${input.name}" not found. Available: ${available || '(none)'}`,
      }
    }
    return { script: input.script ?? named.script, source: named.source }
  }
  if (input.script) {
    return { script: input.script }
  }
  return { error: 'Must provide script, name, or scriptPath' }
}

function getPermissionContext(context: ToolUseContext) {
  return context.getAppState().toolPermissionContext
}

function getNamedRule(
  context: ToolUseContext,
  name: string | undefined,
  behavior: PermissionBehavior,
) {
  if (!name) {
    return undefined
  }
  return getRuleByContentsForToolName(
    getPermissionContext(context),
    WORKFLOW_TOOL_NAME,
    behavior,
  ).get(name)
}

/** Official 2.1.153 `DP8`. */
export function compileWorkflowScript(
  scriptBody: string,
): { ok: true; vmScript: vm.Script } | { ok: false; error: string } {
  const wrapped = `(async () => {
${scriptBody}
})()`
  try {
    // Official: Function(...) is a syntax check; return value is unused.
    Function(`async function _check() {
${scriptBody}
}`)
    return { ok: true, vmScript: new vm.Script(wrapped, { filename: 'workflow.js' }) }
  } catch (error) {
    return {
      ok: false,
      error: `SyntaxError: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  aliases: ['RunWorkflow'],
  searchHint: WORKFLOW_SEARCH_HINT,
  maxResultSizeChars: 100_000,
  isEnabled: () => isWorkflowsEnabled(),
  async prompt() {
    return WORKFLOW_PROMPT
  },
  async description() {
    return WORKFLOW_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input: WorkflowInput) {
    return input.script ?? input.name ?? ''
  },
  async validateInput(input: WorkflowInput, context: ToolUseContext) {
    if (areWorkflowsDisabledByKillSwitch()) {
      return {
        result: false as const,
        message:
          'Dynamic workflows are disabled by managed settings (`disableWorkflows`).',
        errorCode: 5,
      }
    }
    const resolved = await resolveWorkflowInput(input)
    if ('error' in resolved) {
      return { result: false as const, message: resolved.error, errorCode: 1 }
    }
    const parsed = parseWorkflowScript(resolved.script)
    if ('error' in parsed) {
      return {
        result: false as const,
        message: `Script must begin with \`export const meta = { name, description, phases }\` (pure literal). ${parsed.error}`,
        errorCode: 2,
      }
    }
    if (
      input.script &&
      /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/.test(
        parsed.scriptBody,
      )
    ) {
      return {
        result: false as const,
        message:
          'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
        errorCode: 4,
      }
    }
    if (input.resumeFromRunId) {
      const tasks = context.getAppState().tasks ?? {}
      for (const [taskId, task] of Object.entries(tasks)) {
        if (
          'type' in task &&
          task.type === 'local_workflow' &&
          task.status === 'running' &&
          'workflowRunId' in task &&
          task.workflowRunId === input.resumeFromRunId
        ) {
          return {
            result: false as const,
            message: `Workflow ${input.resumeFromRunId} is still running (task ${taskId}). Stop it first with ${TASK_STOP_TOOL_NAME}({taskId: "${taskId}"}) before resuming.`,
            errorCode: 3,
          }
        }
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: WorkflowInput, context: ToolUseContext) {
    const name = input.scriptPath ? undefined : input.name
    const deny = getNamedRule(context, name, 'deny')
    if (deny) {
      return {
        behavior: 'deny' as const,
        message: `Workflow ${name} blocked by permission rules`,
        decisionReason: { type: 'rule' as const, rule: deny },
      }
    }
    let updatedInput = input
    if (input.scriptPath) {
      const fromDisk = await readWorkflowScriptPath(input.scriptPath)
      if (!('error' in fromDisk)) {
        updatedInput = { ...input, script: fromDisk.script }
      }
    } else if (input.name) {
      const named = await findWorkflowByName(input.name, getCwd())
      updatedInput = { ...input, script: named?.script }
    }
    const ask = getNamedRule(context, name, 'ask')
    if (ask) {
      return {
        behavior: 'ask' as const,
        message: 'Review dynamic workflow before running',
        updatedInput,
        decisionReason: { type: 'rule' as const, rule: ask },
      }
    }
    const allow = getNamedRule(context, name, 'allow')
    if (allow) {
      // Official 2.1.153: persist consent when Workflow is allowed.
      recordWorkflowUsageConsent()
      return {
        behavior: 'allow' as const,
        updatedInput,
        decisionReason: { type: 'rule' as const, rule: allow },
      }
    }
    return {
      behavior: 'ask' as const,
      message: 'Review dynamic workflow before running',
      updatedInput,
      ...(name && {
        suggestions: [
          {
            type: 'addRules' as const,
            rules: [{ toolName: WORKFLOW_TOOL_NAME, ruleContent: name }],
            behavior: 'allow' as const,
            destination: 'localSettings' as const,
          },
        ],
      }),
    }
  },
  userFacingName() {
    return 'Workflow'
  },
  /** Official 2.1.153 `L74`. */
  renderToolUseMessage(
    input: Partial<WorkflowInput>,
    { verbose }: { verbose: boolean },
  ) {
    if (input.name) {
      return `dynamic workflow: ${input.name}`
    }
    if (!input.script) {
      return null
    }
    if (verbose) {
      return input.script
    }
    const parsed = parseWorkflowScript(input.script)
    if (!('error' in parsed)) {
      return parsed.meta.description
    }
    const firstLine =
      input.script.split('\n').find(line => line.trim()) ??
      input.script.slice(0, 40)
    const trimmed =
      firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine
    const extraLines = input.script.split('\n').length - 1
    const suffix =
      extraLines > 0
        ? `… +${extraLines} ${extraLines === 1 ? 'line' : 'lines'}`
        : ''
    return suffix ? `${trimmed} ${suffix}` : trimmed
  },
  getToolUseSummary(input: WorkflowInput | undefined) {
    if (input?.name) {
      return `dynamic workflow: ${input.name}`
    }
    if (!input?.script) {
      return null
    }
    const parsed = parseWorkflowScript(input.script)
    if (!('error' in parsed)) {
      return parsed.meta.description
    }
    const firstLine = input.script.split('\n').find(line => line.trim()) ?? ''
    return firstLine.length > 50 ? firstLine.slice(0, 49) + '…' : firstLine
  },
  async call(
    input: WorkflowInput,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
  ) {
    const resolved = await resolveWorkflowInput(input)
    if ('error' in resolved) {
      throw new Error(resolved.error)
    }
    const { script, source, resolvedScriptPath } = resolved
    const parsed = parseWorkflowScript(script)
    if ('error' in parsed) {
      throw new Error(`Invalid workflow script: ${parsed.error}`)
    }
    const runId =
      input.resumeFromRunId ?? `wf_${randomUUID().slice(0, 12)}`
    const taskId = generateTaskId('local_workflow')
    const description = parsed.meta.description
    const workflowName = parsed.meta.name
    const title = parsed.meta.title
    const compiled = compileWorkflowScript(parsed.scriptBody)
    if (compiled.ok === false) {
      logEvent('tengu_feature_bad', {
        feature_name:
          'task_local_workflow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error_code:
          'compile_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return {
        data: {
          status: 'async_launched' as const,
          taskId,
          runId,
          summary: description,
          error: compiled.error,
        },
      }
    }
    const {
      applyWorkflowProgress,
      completeLocalWorkflowTask,
      createWorkflowTaskRegistry,
      failLocalWorkflowTask,
      notifyLocalWorkflowTask,
      registerLocalWorkflowTask,
    } = await import('../../tasks/LocalWorkflowTask/LocalWorkflowTask.js')
    const {
      emitWorkflowProgress,
      getWorkflowTranscriptDir,
      LocalFileJournal,
      persistWorkflowScript,
      persistWorkflowSnapshot,
      runCompiledWorkflow,
      telemetryWorkflowDescription,
      telemetryWorkflowName,
    } = await import('./runtime.js')
    const { getCurrentTurnTokenBudget, getTotalOutputTokens, getTurnOutputTokens } =
      await import('../../bootstrap/state.js')
    const { getIsInteractive } = await import('../../bootstrap/state.js')
    const { logError } = await import('../../utils/log.js')
    const transcriptDir = getWorkflowTranscriptDir(runId)
    const scriptPath = resolvedScriptPath ?? persistWorkflowScript(workflowName, runId, script)
    const workflowSource = input.scriptPath ? 'scriptPath' : source ?? 'inline'
    const telemetryName = telemetryWorkflowName(workflowName, source)
    const telemetryDescription = telemetryWorkflowDescription(
      parsed.meta.description,
      source,
    )
    logEvent('tengu_workflow_launched', {
      invocation_mode: asTelemetry(
        input.scriptPath ? 'scriptPath' : input.name ? 'named' : 'inline',
      ),
      workflow_source: asTelemetry(workflowSource),
      workflow_name: asTelemetry(telemetryName),
      workflow_description: asTelemetry(telemetryDescription),
      phase_count: parsed.meta.phases?.length ?? 0,
      has_args: input.args != null,
      is_resume: input.resumeFromRunId != null,
      script_size_chars: script.length,
    })
    const taskRegistry = createWorkflowTaskRegistry(
      context.getAppState,
      context.setAppState,
    )
    if (input.resumeFromRunId != null) {
      logEvent('tengu_feature_ok', {
        feature_name: asTelemetry('task_local_workflow_resume'),
      })
      for (const [id, task] of Object.entries(taskRegistry.all())) {
        if (
          isLocalWorkflowTask(task) &&
          task.workflowRunId === input.resumeFromRunId &&
          task.status !== 'running'
        ) {
          taskRegistry.remove(id)
        }
      }
    }
    const registered = registerLocalWorkflowTask({
      taskId,
      script,
      scriptPath,
      summary: description,
      workflowName,
      title,
      phases: parsed.meta.phases,
      defaultModel: context.options.mainLoopModel,
      workflowRunId: runId,
      args: input.args,
      taskRegistry,
      toolUseId: context.toolUseId,
    })
    const runContext = {
      ...context,
      abortController: registered.abortController ?? context.abortController,
    }
    const turnStart = getTotalOutputTokens() - getTurnOutputTokens()
    const tokenBudget = {
      total: getCurrentTurnTokenBudget(),
      getTurnSpent: () => getTotalOutputTokens() - turnStart,
    }
    void (async () => {
      const pending: import('../../tasks/LocalWorkflowTask/LocalWorkflowTask.js').WorkflowProgressEvent[] =
        []
      const flushDelay = 16
      let flushTimer: ReturnType<typeof setTimeout> | undefined
      const flush = () => {
        flushTimer = undefined
        if (pending.length === 0) {
          return
        }
        const batch = pending.splice(0, pending.length)
        applyWorkflowProgress(taskId, batch, taskRegistry)
        if (!getIsInteractive()) {
          return
        }
        const visible = batch.filter(event => event.type !== 'workflow_log')
        if (visible.length === 0) {
          return
        }
        const current = runContext.getAppState()?.tasks?.[taskId]
        if (!isLocalWorkflowTask(current) || current.status !== 'running') {
          return
        }
        const lastAgent = [...visible]
          .reverse()
          .find(event => event.type === 'workflow_agent')
        emitWorkflowProgress({
          taskId,
          toolUseId: context.toolUseId,
          description: lastAgent
            ? lastAgent.phaseTitle
              ? `${lastAgent.phaseTitle}: ${lastAgent.label}`
              : lastAgent.label ?? registered.description
            : registered.description,
          startTime: registered.startTime,
          totalTokens: current.totalTokens,
          toolUses: current.totalToolCalls,
          lastToolName: lastAgent?.label,
          summary: description,
          workflowProgress: visible,
        })
      }
      const onProgress = (
        message: import('./runtime.js').WorkflowProgressMessage,
      ) => {
        if (message.type !== 'progress') {
          return
        }
        pending.push(message.data)
        if (!flushTimer) {
          flushTimer = setTimeout(flush, flushDelay)
        }
      }
      const result = await runCompiledWorkflow(
        compiled.vmScript,
        runContext,
        canUseTool,
        {
          workflowRunId: runId,
          onProgress,
          onAgentController: (agentId, controller) => {
            if (controller) {
              registered.agentControllers?.set(agentId, controller)
            } else {
              registered.agentControllers?.delete(agentId)
            }
          },
          args: input.args,
          seedPhaseTitles: parsed.meta.phases?.map(phase => phase.title),
          tokenBudget,
          journal: new LocalFileJournal(runId),
        },
      )
      if (flushTimer) {
        clearTimeout(flushTimer)
      }
      flush()
      const latest = runContext.getAppState()?.tasks?.[taskId]
      const latestWorkflow = isLocalWorkflowTask(latest) ? latest : undefined
      const progress = (latestWorkflow?.workflowProgress ?? []).filter(
        event => event.type !== 'workflow_log',
      )
      const totalTokens = latestWorkflow?.totalTokens ?? 0
      const totalToolCalls = latestWorkflow?.totalToolCalls ?? 0
      const status = registered.abortController?.signal.aborted
        ? 'killed'
        : result.error
          ? 'failed'
          : 'completed'
      logEvent('tengu_workflow_completed', {
        workflow_run_id: asTelemetry(runId),
        workflow_source: asTelemetry(workflowSource),
        workflow_name: asTelemetry(telemetryName),
        workflow_description: asTelemetry(telemetryDescription),
        status: asTelemetry(status),
        agent_count: result.agentCount,
        total_tokens: totalTokens,
        total_tool_calls: totalToolCalls,
        duration_ms: result.durationMs,
      })
      if (workflowSource === 'built-in') {
        const phases = new Map<
          number,
          {
            title: string
            tokens: number
            toolCalls: number
            durationMs: number
            agentCount: number
            errorCount: number
            skipCount: number
          }
        >()
        for (const event of latestWorkflow?.workflowProgress ?? []) {
          if (event.type !== 'workflow_agent') {
            continue
          }
          if (event.phaseIndex === undefined || !event.phaseTitle) {
            continue
          }
          let phase = phases.get(event.phaseIndex)
          if (!phase) {
            phase = {
              title: event.phaseTitle,
              tokens: 0,
              toolCalls: 0,
              durationMs: 0,
              agentCount: 0,
              errorCount: 0,
              skipCount: 0,
            }
            phases.set(event.phaseIndex, phase)
          }
          phase.tokens += event.tokens ?? 0
          phase.toolCalls += event.toolCalls ?? 0
          phase.durationMs += event.durationMs ?? 0
          phase.agentCount += 1
          if (event.state === 'error') {
            if (event.error === 'skipped by user') {
              phase.skipCount += 1
            } else {
              phase.errorCount += 1
            }
          }
        }
        for (const [phaseIndex, phase] of phases) {
          logEvent('tengu_workflow_phase_completed', {
            workflow_run_id: asTelemetry(runId),
            workflow_source: asTelemetry(workflowSource),
            workflow_name: asTelemetry(telemetryName),
            phase_index: phaseIndex,
            phase_title: asTelemetry(phase.title),
            phase_tokens: phase.tokens,
            phase_tool_calls: phase.toolCalls,
            phase_agent_duration_ms: phase.durationMs,
            phase_agent_count: phase.agentCount,
            phase_error_count: phase.errorCount,
            phase_skip_count: phase.skipCount,
          })
        }
      }
      await persistWorkflowSnapshot(runId, {
        taskId,
        script,
        scriptPath,
        args: input.args,
        result: result.result,
        agentCount: result.agentCount,
        logs: result.logs,
        durationMs: result.durationMs,
        error: result.error,
        summary: description,
        workflowName,
        title,
        status,
        startTime: registered.startTime,
        phases: registered.phases,
        defaultModel: registered.defaultModel,
        workflowProgress: progress,
        totalTokens,
        totalToolCalls,
      })
      if (registered.abortController?.signal.aborted) {
        return
      }
      if (result.error) {
        failLocalWorkflowTask(
          taskId,
          result.error,
          result.agentCount,
          result.logs,
          taskRegistry,
        )
      } else {
        completeLocalWorkflowTask(
          taskId,
          result.result,
          result.agentCount,
          result.logs,
          taskRegistry,
        )
      }
      notifyLocalWorkflowTask({
        taskId,
        summary: description,
        status: result.error ? 'failed' : 'completed',
        error: result.error,
        result: result.result,
        failures: result.failures,
        agentCount: result.agentCount,
        totalTokens,
        totalToolCalls,
        durationMs: result.durationMs,
        taskRegistry,
        toolUseId: context.toolUseId,
        transcriptDir,
      })
    })().catch(error => {
      logError(error)
      const message = error instanceof Error ? error.message : String(error)
      const current = runContext.getAppState()?.tasks?.[taskId]
      const agentCount =
        current && 'agentCount' in current ? current.agentCount : 0
      failLocalWorkflowTask(
        taskId,
        message,
        agentCount,
        current && 'logs' in current ? current.logs : [],
        taskRegistry,
      )
      notifyLocalWorkflowTask({
        taskId,
        summary: description,
        status: 'failed',
        error: message,
        agentCount,
        totalTokens:
          current && 'totalTokens' in current ? current.totalTokens : 0,
        totalToolCalls:
          current && 'totalToolCalls' in current ? current.totalToolCalls : 0,
        durationMs: Date.now() - registered.startTime,
        taskRegistry,
        toolUseId: context.toolUseId,
        transcriptDir,
      })
    })
    return {
      data: {
        status: 'async_launched' as const,
        taskId,
        runId,
        summary: description,
        transcriptDir,
        scriptPath,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content: WorkflowOutput, toolUseID: string) {
    if (content.error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Workflow script has a syntax error and was not launched:\n${content.error}`,
        is_error: true,
      }
    }
    if (content.status === 'remote_launched') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content:
          `Workflow launched in a remote CCR session. Task ID: ${content.taskId}\nSession: ${content.sessionUrl}\n` +
          (content.summary ? `Summary: ${content.summary}\n` : '') +
          (content.warning ? `Warning: ${content.warning}\n` : '') +
          `\nThe workflow runs against a fresh clone of the pushed branch; phase progress is visible at the session URL, not in /workflows. You will be notified when it completes.`,
        is_error: false,
      }
    }
    const summary = content.summary ? `\nSummary: ${content.summary}` : ''
    const transcriptDir = content.transcriptDir
      ? `\nTranscript dir: ${content.transcriptDir}`
      : ''
    const scriptFile = content.scriptPath
      ? `\nScript file: ${content.scriptPath}\n(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${content.scriptPath}"} to iterate without resending the script.)`
      : ''
    const resume =
      content.scriptPath && content.runId
        ? `\nRun ID: ${content.runId}\nTo resume after editing the script: Workflow({scriptPath: "${content.scriptPath}", resumeFromRunId: "${content.runId}"}) — completed agents return cached results.`
        : ''
    const text = `Workflow launched in background. Task ID: ${content.taskId}${summary}${transcriptDir}${scriptFile}${resume}\n\nYou will be notified when it completes. Use /workflows to watch live progress.`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: text,
      is_error: false,
    }
  },
} satisfies ToolDef<InputSchema, WorkflowOutput>)
