import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { ToolUseContext } from '../../Tool.js'
import { isCommandEnabled } from '../../types/command.js'
import {
  convertEffortValueToLevel,
  EFFORT_LEVELS,
  isEffortLevel,
  resolveAppliedEffort,
  type EffortLevel,
  type EffortValue,
} from '../../utils/effort.js'
import { registerBundledSkill } from '../bundledSkills.js'

/** Official 2.1.152 `sv8`. */
function parseFlagArgs(
  args: string,
  flags: string[],
): { rawFirstToken: string; flags: Set<string>; rest: string } {
  let rest = args.trim()
  const rawFirstToken = rest.split(/\s+/, 1)[0] ?? ''
  const found = new Set<string>()
  for (const flag of flags) {
    const next = rest.replace(
      new RegExp(`(?:^|\\s)--${flag}(?=\\s|$)`, 'g'),
      '',
    )
    if (next !== rest) found.add(flag)
    rest = next.trim()
  }
  return { rawFirstToken, flags: found, rest }
}

/** Official 2.1.147 `g49` / 2.1.152 `a9q`. */
export function parseCodeReviewArgs(args: string): {
  explicit: EffortLevel | undefined
  target: string
  comment: boolean
  fix: boolean
  unrecognizedLevel: string | undefined
  ultraFallback: boolean
} {
  const { rawFirstToken, flags, rest } = parseFlagArgs(args, ['comment', 'fix'])
  const comment = flags.has('comment')
  const fix = flags.has('fix')
  const parts = rest.split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  if (rawFirstToken.toLowerCase() === 'ultra') {
    return {
      explicit: undefined,
      target: parts.slice(1).join(' '),
      comment,
      fix,
      unrecognizedLevel: undefined,
      ultraFallback: true,
    }
  }
  const alias = first.trim().toLowerCase()
  const mapped = alias === 'ultra' ? undefined : alias === 'med' ? 'medium' : alias
  if (mapped !== undefined && isEffortLevel(mapped)) {
    return {
      explicit: mapped,
      target: parts.slice(1).join(' '),
      comment,
      fix,
      unrecognizedLevel: undefined,
      ultraFallback: false,
    }
  }
  const looksLikeLevel = /^(low|med|hig|xhi|max)[a-z]*$/i.test(first)
  return {
    explicit: undefined,
    target: rest,
    comment,
    fix,
    unrecognizedLevel: looksLikeLevel ? first : undefined,
    ultraFallback: false,
  }
}

function sessionEffort(context: ToolUseContext): EffortValue | undefined {
  return context.getEffortValue?.() ?? context.getAppState().effortValue
}

const PHASE0_GATHER = "## Phase 0 — Gather the diff\n\nRun `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`\nif there's no upstream) to get the unified diff under review. If there are\nuncommitted changes, or the range diff is empty, also run `git diff HEAD` and\ninclude the working-tree changes in scope — the review often runs before the\ncommit. If a PR number, branch name, or file path was passed as an argument,\nreview that target instead. Treat this diff as the review scope.\n"
const ANGLE_ABC = "### Angle A — line-by-line diff scan\n\nRead every hunk in the diff, line by line. Then Read the enclosing function for\neach hunk — bugs in unchanged lines of a touched function are in scope (the PR\nre-exposes or fails to fix them). For every line ask: what input, state, timing,\nor platform makes this line wrong? Look for inverted/wrong conditions,\noff-by-one, null/undefined deref, missing `await`, falsy-zero checks,\nwrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.\n\n### Angle B — removed-behavior auditor\n\nFor every line the diff DELETES or replaces, name the invariant or behavior it\nenforced, then search the new code for where that invariant is re-established.\nIf you can't find it, that's a candidate: a removed guard, a dropped error\npath, a narrowed validation, a deleted test that was covering a real case.\n\n### Angle C — cross-file tracer\n\nFor each function the diff changes, find its callers (Grep for the symbol) and\ncheck whether the change breaks any call site: a new precondition, a changed\nreturn shape, a new exception, a timing/ordering dependency. Also check callees:\ndoes a parallel change in the same PR make a call unsafe?\n"
const VERIFY_PRECISION_TMPL = "## Phase 2 — Verify (1-vote, 3-state)\n\nDedup candidates that point at the same line/mechanism, keeping the one with\nthe most concrete failure scenario. For each remaining candidate, run **one\nverifier** via the ${AGENT} tool: give it the diff, the relevant\nfile(s), and the candidate, and have it return exactly one of:\n\n- **CONFIRMED** — can name the inputs/state that trigger it and the wrong\n  output or crash. Quote the line.\n- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,\n  config). State what would confirm it.\n- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.\n  Quote the line that proves it.\n\nKeep candidates where the vote is CONFIRMED or PLAUSIBLE.\n"
const VERIFY_RECALL_TMPL = "## Phase 2 — Verify (1-vote, recall-biased)\n\nDedup near-duplicates (same defect, same location, same reason → keep one). For\neach remaining candidate, run **one verifier** via the ${AGENT} tool:\ngive it the diff, the relevant file(s), and the candidate; it returns exactly\none of **CONFIRMED / PLAUSIBLE / REFUTED**.\n\n**PLAUSIBLE by default** — do not refute a candidate for being \"speculative\" or\n\"depends on runtime state\" when the state is realistic: concurrency races,\nnil/undefined on a rare-but-reachable path (error handler, cold cache, missing\noptional field), falsy-zero treated as missing, off-by-one on a boundary the\ncode does not exclude, retry storms / partial failures, regex/allowlist that\nlost an anchor. These are PLAUSIBLE.\n\n**REFUTED** only when constructible from the code: factually wrong (quote the\nactual line); provably impossible (type/constant/invariant — show it); already\nhandled in this diff (cite the guard); or pure style with no observable effect.\n\nKeep **CONFIRMED and PLAUSIBLE**. Drop REFUTED.\n"
const SWEEP = "## Phase 3 — Sweep for gaps\n\nRun **one more finder** as a fresh reviewer who has the verified list. Re-read\nthe diff and enclosing functions looking ONLY for defects not already listed.\nDo not re-derive or re-confirm anything already there — the job is gaps. Focus\non what the first pass tends to miss: moved/extracted code that dropped a guard\nor anchor; second-tier footguns (dataclass default evaluated once, `hash()`\nnon-determinism, lock-scope shrink, predicate methods with side effects);\nsetup/teardown asymmetry in tests; config defaults flipped.\n\nSurface **up to 8 additional candidates**, each naming a defect not already on\nthe list. If nothing new, return an empty sweep — do not pad.\n"
const ANGLES_DE_TMPL = "${ANGLE}\n### Angle D — language-pitfall specialist\n\nScan for the classic pitfalls of the diff's language/framework — for example:\nJS falsy-zero, `==` coercion, closure-captured loop var; Python mutable default\nargs, late-binding closures; Go nil-map write, range-var capture; SQL injection;\ntimezone/DST drift; float equality. Flag any instance the diff introduces.\n\n### Angle E — wrapper/proxy correctness\n\nWhen the PR adds or modifies a type that wraps another (cache, proxy, decorator,\nadapter): check that every method routes to the wrapped instance and not back\nthrough a registry/session/global — e.g. a caching provider holding a\n`delegate` field that resolves IDs via `session.get(...)` instead of\n`delegate.get(...)` will re-enter the cache or recurse. Also check that the\nwrapper forwards all the methods the callers actually use.\n"
const OUTPUT_TMPL = "## Output\n\nReturn findings as a JSON array of at most ${H} objects:\n\n```json\n[\n  {\n    \"file\": \"path/to/file.ext\",\n    \"line\": 123,\n    \"summary\": \"one-sentence statement of the bug\",\n    \"failure_scenario\": \"concrete inputs/state → wrong output/crash\"\n  }\n]\n```\n\nRanked most-severe first. If more than ${H} survive, keep the ${H} most\nsevere. If nothing survives verification, return `[]`.\n"
const LOW_PROMPT = "`low effort → 1 diff pass → no verify → ≤4 findings`\n\n## Turn 1 — read\n\nOne tool call: read the unified diff (`git diff @{upstream}...HEAD; git diff HEAD`\nto cover both committed and uncommitted changes, or `git diff main...HEAD` /\nthe target passed as an argument). Skip test/fixture\nhunks (`test/`, `spec/`, `__tests__/`, `*_test.*`, `*.test.*`,\n`fixtures/`, `testdata/`) — test-file changes are not reviewed at this level.\nNo subagents, no full-file reads.\n\n## Turn 2 — findings\n\nFlag only runtime-correctness bugs visible from the hunk alone: inverted/wrong\ncondition, off-by-one, null/undefined deref where adjacent lines show the value\ncan be absent, removed guard, falsy-zero check, missing `await`,\nwrong-variable copy-paste, error swallowed in a catch that should propagate.\n\nDo **not** flag style, naming, perf, missing tests, or anything outside the\nhunk.\n\nOutput at most **4 findings**, most-severe first, one line each:\n`path/to/file.ext:123 — what's wrong and the concrete failure`. If nothing\nqualifies, output exactly `(none)`.\n"
const FIX_APPENDIX = `

## Applying fixes (--fix)

The \`--fix\` flag was passed. After producing the findings list, apply the
findings to the working tree instead of stopping at the report: fix each one
directly \u2014 correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive \u2014 note the
skip rather than arguing with it. Finish with a brief summary of what was fixed
and what was skipped.
`

const GITHUB_COMMENT_APPENDIX = "\n\n## Posting to GitHub (--comment)\n\nThe `--comment` flag was passed. After producing the findings list, if the\nreview target is a GitHub PR, post each finding as an inline PR comment via\n`mcp__github_inline_comment__create_inline_comment` (one call per finding;\ninclude a suggestion block only when it fully fixes the issue). If that tool\nis not available in this session, fall back to `gh api` (repos/{owner}/{repo}/pulls/{pr}/comments)\nor print the findings instead. If the target is not a PR, print the findings\nto the terminal and note that `--comment` was ignored.\n"
const MEDIUM_TMPL = "`medium effort → 3 angles × 6 candidates → 1-vote verify → ≤8 findings`\n\nYou are reviewing for **precision** at medium effort: every finding you surface\nshould be one a maintainer would act on.\n\n${PHASE0}\n## Phase 1 — Find candidates (3 angles, up to 6 each)\n\nRun **3 independent finder angles** via the ${AGENT} tool. Each\nsurfaces **up to 6 candidate findings** with `file`, `line`, a one-line\n`summary`, and a concrete `failure_scenario`.\n\n${ANGLE}\nPass every candidate with a nameable failure scenario through — finders that\nsilently drop half-believed candidates bypass the verify step and are the\ndominant cause of misses.\n\n${VERIFY_P}\n${OUT8}"
const HIGH_TMPL = "`high effort → 3 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10 findings`\n\nYou are reviewing for **recall** at high effort: catch every real bug a careful\nreviewer would catch in one sitting. At this level, catching real bugs matters\nmore than avoiding false positives. Err on the side of surfacing.\n\n${PHASE0}\n## Phase 1 — Find candidates (3 angles, up to 6 each)\n\nRun **3 independent finder angles** via the ${AGENT} tool. Each\nsurfaces **up to 6 candidate findings** with `file`, `line`, a one-line\n`summary`, and a concrete `failure_scenario`.\n\n${ANGLE}\nPass every candidate with a nameable failure scenario through — finders that\nsilently drop half-believed candidates bypass the verify step and are the\ndominant cause of misses.\n\n${VERIFY_R}\n${OUT10}"
const XHIGH_TMPL = "`${LEVEL} effort → 5 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings`\n\nYou are reviewing for **recall** at ${WORD} effort: catch every real bug. At\nthis level, catching real bugs matters more than avoiding false positives — a\nmissed bug ships. Err on the side of surfacing.\n\n${PHASE0}\n## Phase 1 — Find candidates (5 angles, up to 8 each)\n\nRun **5 independent finder angles** via the ${AGENT} tool. Each\nsurfaces **up to 8 candidate findings**. Do NOT let one angle's conclusions\nsuppress another's — if two angles flag the same line for different reasons,\nrecord both.\n\n${ANGLES_DE}\n${VERIFY_P}\nThis is recall mode — a single non-REFUTED vote carries the finding. Do NOT\ndrop on uncertainty.\n\n${SWEEP}\n${OUT15}"

function fill(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.split('${' + key + '}').join(value)
  }
  return out
}

function outputCap(max: number): string {
  return OUTPUT_TMPL.split('${H}').join(String(max))
}

function withAgent(tmpl: string): string {
  return tmpl.split('${AGENT}').join(AGENT_TOOL_NAME)
}

function mediumPrompt(): string {
  return fill(MEDIUM_TMPL, {
    PHASE0: PHASE0_GATHER,
    ANGLE: ANGLE_ABC,
    VERIFY_P: withAgent(VERIFY_PRECISION_TMPL),
    OUT8: outputCap(8),
    AGENT: AGENT_TOOL_NAME,
  })
}

function highPrompt(): string {
  return fill(HIGH_TMPL, {
    PHASE0: PHASE0_GATHER,
    ANGLE: ANGLE_ABC,
    VERIFY_R: withAgent(VERIFY_RECALL_TMPL),
    OUT10: outputCap(10),
    AGENT: AGENT_TOOL_NAME,
  })
}

function extraHighPrompt(level: 'xhigh' | 'max'): string {
  const anglesDe = fill(ANGLES_DE_TMPL, {
    ANGLE: ANGLE_ABC,
    AGENT: AGENT_TOOL_NAME,
  })
  return fill(XHIGH_TMPL, {
    LEVEL: level,
    WORD: level === 'max' ? 'maximum' : 'extra-high',
    PHASE0: PHASE0_GATHER,
    ANGLES_DE: anglesDe,
    VERIFY_P: withAgent(VERIFY_PRECISION_TMPL),
    SWEEP,
    OUT15: outputCap(15),
    AGENT: AGENT_TOOL_NAME,
  })
}

const GOA: Record<EffortLevel, () => string> = {
  low: () => LOW_PROMPT,
  medium: mediumPrompt,
  high: highPrompt,
  xhigh: () => extraHighPrompt('xhigh'),
  max: () => extraHighPrompt('max'),
}

/** Official 2.1.152 `ihz`. */
function ihz(): string {
  return `Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level (low/medium: fewer, high-confidence findings; high\u2192max: broader coverage, may include uncertain findings${isUltrareviewEnabled() ? '; ultra: deep multi-agent review in the cloud' : ''}). Pass --comment to post findings as inline PR comments, or --fix to apply the findings to the working tree after the review.`
}

/** Official 2.1.152 `rhz`. */
function rhz(): string {
  const levels = EFFORT_LEVELS.join('|')
  return `[${isUltrareviewEnabled() ? `${levels}|ultra` : levels}] [--fix] [--comment] [<target>]`
}

/** Official 2.1.152 `ohz`. */
function ohz({
  ultraFallback,
  fix,
  unrecognizedLevel,
  level,
  context,
}: {
  ultraFallback: boolean
  fix: boolean
  unrecognizedLevel: string | undefined
  level: EffortLevel
  context: ToolUseContext
}): string {
  if (ultraFallback) {
    if (!isUltrareviewEnabled()) {
      if (fix) {
        return `(Running a local ${level}-effort review and applying its findings.)\n\n`
      }
      return `(ultra (cloud review) isn't available in this environment \u2014 see https://code.claude.com/docs/en/ultrareview. Falling back to a local ${level}-effort review.)\n\n`
    }
    const hasUltrareview =
      context.options?.commands?.some(
        cmd => cmd.name === 'ultrareview' && isCommandEnabled(cmd),
      ) ?? false
    if (fix) {
      return hasUltrareview
        ? `(Claude can't launch the cloud review directly \u2014 type \`/code-review ultra --fix\` to review in the cloud and apply the findings locally when it completes. Running a local ${level}-effort review and applying its findings for now.)\n\n`
        : `(Running a local ${level}-effort review and applying its findings.)\n\n`
    }
    return hasUltrareview
      ? `(Claude can't launch the cloud review directly \u2014 type \`/code-review ultra\` to run it. Falling back to a local ${level}-effort review for now.)\n\n`
      : `(Claude can't launch the cloud review directly \u2014 the user can run \`claude ultrareview\` from a terminal to start it. Falling back to a local ${level}-effort review for now.)\n\n`
  }
  if (unrecognizedLevel !== undefined) {
    return `(Ignoring unrecognized effort "${unrecognizedLevel}"; valid: ${EFFORT_LEVELS.join(', ')}. Using ${level}.)\n\n`
  }
  return ''
}

/** Official 2.1.152 `_J9`. */
async function codeReviewPrompt(
  args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; text: string }[]> {
  const { explicit, target, comment, fix, unrecognizedLevel, ultraFallback } =
    parseCodeReviewArgs(args)
  const requested = ultraFallback ? 'max' : explicit
  const model = context.options.mainLoopModel
  const resolved = model
    ? (resolveAppliedEffort(model, requested ?? sessionEffort(context)) ??
      requested)
    : (requested ?? sessionEffort(context))
  const level: EffortLevel =
    resolved === undefined ? 'medium' : convertEffortValueToLevel(resolved)
  const warning = ohz({
    ultraFallback,
    fix,
    unrecognizedLevel,
    level,
    context,
  })
  const targetBlock = target ? `Review target: \`${target}\`\n\n` : ''
  return [
    {
      type: 'text',
      text: `${warning}${targetBlock}${GOA[level]()}${comment ? GITHUB_COMMENT_APPENDIX : ''}${fix ? FIX_APPENDIX : ''}`,
    },
  ]
}

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'code-review',
    description: ihz(),
    argumentHint: rhz(),
    userInvocable: true,
    getEffort: args => parseCodeReviewArgs(args).explicit,
    getPromptForCommand: codeReviewPrompt,
  })
  registerBundledSkill({
    name: 'simplify',
    description:
      'Review the current diff and apply the fixes — equivalent to /code-review --fix.',
    argumentHint: `[${EFFORT_LEVELS.join('|')}] [--comment] [<target>]`,
    userInvocable: true,
    getEffort: args => parseCodeReviewArgs(args).explicit,
    async getPromptForCommand(args, context) {
      return codeReviewPrompt(`${args} --fix`.trim(), context)
    },
  })
}
