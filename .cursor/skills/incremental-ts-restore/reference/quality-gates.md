# Quality Gates for Incremental Restore

A version hop is done only when all quality criteria are met.

## Verification Checklist

### 1. Structural Comparison Review (astdiff)

- Run `astdiff <from>/cli.js <to>/cli.js --summary` to confirm matched declarations and overall similarity.
- Inspect all modified, added, and removed declarations via `astdiff`.
- Verify that every structural modification correlates with either:
  1. A feature or bugfix described in the official CHANGELOG for that version.
  2. Internal refactoring, dependency updates, or bundler changes evident in the AST diff.

### 2. TypeScript Delta Gate

This tree does not typecheck at 0 errors and never has: HEAD carries thousands of pre-existing errors from generated stubs and missing vendor types. Chasing 0 is a trap that eats a hop. The gate is **no new errors**.

```bash
# Step 0 of the hop, before landing anything
git worktree add /tmp/ccbase HEAD
(cd /tmp/ccbase && bun run typecheck 2>&1 | grep -oE '^src/[^(]+' | sort | uniq -c | sort -k2) > /tmp/base_counts.txt

# After each landing batch
bun run typecheck 2>&1 | grep -oE '^src/[^(]+' | sort | uniq -c | sort -k2 > /tmp/now.txt
diff /tmp/base_counts.txt /tmp/now.txt
```

- The diff must be empty, or show only **decreases** (a landing that happens to fix pre-existing errors is fine).
- Compare **per-file counts**, never the grand total — a total can stay flat while a new error hides behind one you fixed.
- Re-run after each batch, not once at the end, so a regression is attributed to the edit that caused it.

### 3. Build Gate (hard)

- `bun run build` must succeed and produce `dist/cli.js`.
- **Every version must build.** No hop is complete or committed with a red build. If a landing breaks it, finish it or revert it inside the same hop — never carry a broken build into the next version.
- Building green is necessary but not sufficient: dead code, an unexported helper, and an unreferenced module all build fine.

### 4. Bundle Reachability Gate

Assert the hop's unique tokens actually reached the shipped bundle:

```bash
for t in <tokens from the scout doc>; do
  printf '%-45s %s\n' "$t" "$(grep -c -F -- "$t" dist/cli.js)"
done
```

- Every `product` row in `restore-work/diffs/<ver>-changelog-scout.md` must have a non-zero count.
- A zero means the code exists in `src/` but is unreachable from the entry point — the feature did not actually land.

### 5. CHANGELOG Completeness Gate

- Every item in the official CHANGELOG under `## <version>` must be mapped to corresponding structural AST changes in `cli.js` or confirmed as absent (e.g. docs, packaging, VS Code extension only).
- Recorded in `restore-work/ledgers/<ver>.json`, one row per item, each with a status of `located` / `partial` / `shared-logic` / `absent-in-bundle` and evidence naming the official minified identifier.
- `partial` is a legitimate outcome when the tree lacks a subsystem the official change touches — say so in the evidence rather than inflating it to `located`.

### 6. Pre-commit Parallel Review Gate

- A second wave of domain subagents must audit the landed TypeScript against `astdiff` and CHANGELOG **after** gates 1–5 and **before** the restore commit.
- Each domain writes `restore-work/diffs/<ver>-<domain>-review.md` with a `## Verdict` of `clean` / `fix-before-commit` / `block`, plus `## Findings` (each with severity, `file:line`, what the bundle does, what the TS does, the fix) and `## Verified-correct`.
- A silent, unresponsive, or missing reviewer is a `FAIL`. The main agent may not waive this by reviewing alone — a landing agent reviewing its own work is the exact failure mode this gate exists to catch.
- Review prompts must be self-contained: changed-file list, official minified identifiers, bundle paths, the `node -e` extraction recipe, the output path, and the required headings. Name the riskiest thing in the domain so the reviewer spends its attention there.
- All blocking findings must be fixed and the affected reviewer re-run before commit.

### 7. Special Hop Gates

- **2.1.112 → 2.1.113 Bridge**: Must compare unpatched SEA `cli.js` against official 2.1.112 first to verify product changes, and compare unpatched SEA vs Cometix patched `cli.js` to isolate known Cometix P1–P9 compatibility patches.
- **Sequential progression**: No hop skipped in the version walk path.
