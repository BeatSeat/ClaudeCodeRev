# Quality Gates for Incremental Restore

A version hop is done only when all quality criteria are met.

## Verification Checklist

### 1. Structural Comparison Review (astdiff)

- Run `astdiff <from>/cli.js <to>/cli.js --summary` to confirm matched declarations and overall similarity.
- Inspect all modified, added, and removed declarations via `astdiff`.
- Verify that every structural modification correlates with either:
  1. A feature or bugfix described in the official CHANGELOG for that version.
  2. Internal refactoring, dependency updates, or bundler changes evident in the AST diff.

### 2. TypeScript Compilation Gate

- Run `bun run typecheck` across the entire workspace.
- **Must pass with 0 errors**.

### 3. Build & Bundler Gate

- Run `bun run build`.
- Must successfully compile and bundle to `dist/cli.js` without resolution or runtime syntax failures.

### 4. CHANGELOG Completeness Gate

- Every item in the official CHANGELOG under `## <version>` must be mapped to corresponding structural AST changes in `cli.js` or confirmed as absent (e.g. docs, packaging, VS Code extension only).

### 5. Special Hop Gates

- **2.1.112 → 2.1.113 Bridge**: Must compare unpatched SEA `cli.js` against official 2.1.112 first to verify product changes, and compare unpatched SEA vs Cometix patched `cli.js` to isolate known Cometix P1–P9 compatibility patches.
- **Sequential progression**: No hop skipped in the version walk path.
