import { registerBundledWorkflow } from './index.js'
import { CODE_REVIEW_WORKFLOW_TEMPLATE } from './codeReviewTemplate.js'

/** Official 2.1.160 `WiH`. */
const CODE_REVIEW_WORKFLOW_NAME = 'code-review'

/** Official 2.1.160 `WX4`. */
const DESCRIPTION =
  'Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.'

/** Official 2.1.160 `ZX4`. */
const WHEN_TO_USE =
  'Launched by the /code-review skill at high, xhigh, or max effort when workflows are enabled. Pass args as "<level> [target]" — level is high, xhigh, or max; target is an optional PR number, branch, ref range, path, or free-form review instructions (e.g. "only review src/foo.ts", "focus on error handling").'

/** Official 2.1.160 `GX4`. */
const PHASES = [
  {
    title: 'Scope',
    detail: 'Pin the diff command, changed files, and conventions',
  },
  {
    title: 'Find',
    detail:
      'One finder agent per review angle (correctness + cleanup), streaming into verify',
  },
  {
    title: 'Verify',
    detail:
      'One independent verifier per candidate — CONFIRMED / PLAUSIBLE / REFUTED',
  },
  {
    title: 'Sweep',
    detail: 'Fresh finder hunting only for gaps (xhigh/max)',
  },
  {
    title: 'Synthesize',
    detail: 'Merge duplicates, rank, cap the report',
  },
]

/** Official 2.1.160 `AX4`–`OX4` → `Nl5`. */
const CORRECTNESS_ANGLES = [
  {
    label: 'angle-A',
    text: `### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.`,
  },
  {
    label: 'angle-B',
    text: `### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.`,
  },
  {
    label: 'angle-C',
    text: `### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?`,
  },
  {
    label: 'angle-D',
    text: `### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.`,
  },
  {
    label: 'angle-E',
    text: `### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.`,
  },
]

/** Official 2.1.160 `x$$` / `hPH` / `SPH` / `RPH` → `El5`. */
const CLEANUP_ANGLES = [
  {
    label: 'reuse',
    text: `### Reuse

Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.`,
  },
  {
    label: 'simplification',
    text: `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.`,
  },
  {
    label: 'efficiency',
    text: `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Name the cheaper alternative.`,
  },
  {
    label: 'altitude',
    text: `### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.`,
  },
]

/** Official 2.1.160 `pc6`. */
const VERDICT_LADDER = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`

/** Official 2.1.160 `Uc6`. */
const VERDICT_LADDER_RECALL = `**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`

/** Official 2.1.160 `Hk$`. */
const CLEANUP_PRECEDENCE = `Cleanup and altitude candidates use the same \`file\`/\`line\`/\`summary\` shape; in
\`failure_scenario\`, state the concrete cost (what is duplicated, wasted, or
harder to maintain) instead of a crash. Correctness bugs always outrank
cleanup and altitude findings when the output cap forces a cut.
`

/** Official 2.1.160 `Fc6`. */
const SWEEP_GAP_FOCUS = `moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`

function interpolateOfficialTemplate(template: string): string {
  const vars: Record<string, unknown> = {
    WiH: CODE_REVIEW_WORKFLOW_NAME,
    WX4: DESCRIPTION,
    ZX4: WHEN_TO_USE,
    GX4: PHASES,
    Nl5: CORRECTNESS_ANGLES,
    El5: CLEANUP_ANGLES,
    pc6: VERDICT_LADDER,
    Uc6: VERDICT_LADDER_RECALL,
    Hk$: CLEANUP_PRECEDENCE,
    Fc6: SWEEP_GAP_FOCUS,
  }
  return template.replace(
    /\$\{JSON\.stringify\(([A-Za-z0-9_$]+)\)\}/g,
    (_, key: string) => JSON.stringify(vars[key]),
  )
}

/**
 * Official 2.1.160 `TX4`. Hidden workflow launched by `/code-review` at
 * high/xhigh/max when workflows are enabled. Do not backfill 159 `yX4`.
 */
export function registerCodeReviewWorkflow(): void {
  registerBundledWorkflow(
    interpolateOfficialTemplate(CODE_REVIEW_WORKFLOW_TEMPLATE),
    {
      name: CODE_REVIEW_WORKFLOW_NAME,
      description: DESCRIPTION,
      whenToUse: WHEN_TO_USE,
      phases: PHASES,
    },
    { hidden: true },
  )
}
