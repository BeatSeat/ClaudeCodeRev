# AGENTS.md

## What this repo is

Recovered TypeScript source of `@anthropic-ai/claude-code`, baselined at 2.1.88 (rebuilt from the npm sourcemap) and incrementally restored forward, one version hop at a time, to track official releases. HEAD currently sits at the latest committed hop (see `package.json` `version` — it is bumped every hop and is load-bearing: the build embeds it). Personal study purposes only; original code is Anthropic PBC's.

The primary activity in this repo is **restore hops**, not feature development. Before touching anything related to restoring a version, read `.cursor/skills/incremental-ts-restore/SKILL.md` — it defines the whole workflow, hard rules, and quality gates. Docs it references live in `.cursor/skills/incremental-ts-restore/{inventory,reference}/`.

## Layout

- `src/` — recovered source (~1900 files). Entry point: `src/entrypoints/cli.tsx`. Major areas: `tools/` (one dir per tool), `services/`, `components|screens|ink/` (React/Ink TUI), `bridge/`, `query/`, `hooks/`, `plugins/`, `skills/`.
- `packages/` — local file-deps: `@ant/*` (internal Anthropic packages from sourcemap), `@anthropic-ai/claude-agent-sdk`, TS ports of native modules (`color-diff-napi`, `modifiers-napi`), `audio-capture`, `ripgrep` binaries.
- `scripts/build.ts` — Bun bundler; resolves FEATURE_FLAGS → compile-time booleans and MACRO.* defines, bundles to a single-file `dist/cli.js`. `scripts/gen-stubs.ts` regenerates stubs for DCE'd modules (runs via `prebuild`).
- `restore-work/` — restore state: `ledgers/<ver>.json` (per-hop CHANGELOG coverage, kept in git), `diffs/` (astdiff output, scout docs, reviews), `artifacts/` (official/Cometix `cli.js` bundles, gitignored), `scratch/`.
- `patches/commander@13.0.0.patch` — required loose short-flag parsing; keep patched.
- `bunfig.toml` — dev-time MACRO defines hardcoded to 2.1.88 (dev only; `build.ts` computes real values).

## Commands

Package manager is **bun** (`bun.lock`, no npm lockfile).

```bash
bun install
bun run dev          # run src directly with Bun
bun run build        # production build → dist/cli.js (runs gen-stubs first)
bun run build:dev    # dev build: all feature flags on, no minify
bun run typecheck    # bun tsc --noEmit
bun run start        # node dist/cli.js
```

There is **no test suite and no linter**. Verification = typecheck delta (below) + build success + unique-token grep in `dist/cli.js`.

## Hard-won gotchas

- **Typecheck never passes at 0 errors.** HEAD carries thousands of pre-existing errors from stub generation and missing vendor types. The gate is **zero new errors vs a clean-HEAD baseline, counted per file** (a flat total can hide a new error). Recipe in the SKILL.md §5 (Gates). Record the baseline before editing; re-diff after each batch.
- **`cli.js` bundles are ~14 MB on a single line.** Never `cat`, `head`, or `rg -o` them — extract windows with `node -e '…s.indexOf(token)…s.slice(i,i+800)'`. Full recipe in SKILL.md §2.
- **Line endings are noisy.** Use `git diff --ignore-all-space --stat` to find real changes; never treat CRLF churn as a change.
- **Imports use `src/...` root-relative paths** (Bun resolves them; tsconfig `paths` mirrors this). tsconfig is `strict: false` on purpose — don't tighten it or "fix" relaxed typing wholesale.
- **Feature flags:** production build ships most experimental flags OFF (see `FEATURE_FLAGS` in `scripts/build.ts`); `--dev` turns all on and overrides are possible via `FEATURE_*` env vars.
- **Restore inputs:** official npm 2.1.113+ has no analyzable JS (thin installer) — use Cometix platform packages for 2.1.113+ per SKILL.md "Version path". Never improvise the walk order or skip hops.
- **Commit message for a landed hop:** `restore: align TypeScript tree with official <ver>`. A hop is not commit-eligible until the ledger is written and the pre-commit parallel review wave reports clean (main-agent-only review does not count).
- `undefined/` and `restore-work/scratch/` are untracked junk/work areas — leave them out of commits.

## Sensitive areas

When editing restore inputs/outputs, keep the ledger (`restore-work/ledgers/`) and scout docs as the source of truth for what was landed and why; evidence must name official minified identifiers. Never invent behavior the bundle doesn't contain — copy strings verbatim from the bundle.
