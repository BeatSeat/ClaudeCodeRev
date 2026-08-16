# Quality gates

`quality-gate.mjs` is necessary, not sufficient. A hop is done only when all of the following hold.

## Script gate

```bash
node .cursor/skills/incremental-ts-restore/scripts/quality-gate.mjs --ledger restore-work/ledgers/<ver>.json
```

Fails if:

- missing `version` / `fromVersion`
- a function has an unknown `class`
- `small-edit` / `rewrite` / `added` lack `evidence`
- `unchanged` has `rewrittenByLlm: true`
- `expectedFunctionCount` mismatches
- a CHANGELOG item is missing from `changelogCoverage`
- 2.1.113 lacks `bridge.unpatchedSeaPath`

## Human / agent gate (not scripted yet)

- `bun run build` produces `dist/cli.js` (this is the bar; `bun run typecheck` has many pre-existing errors)
- Every astdiff **product** hit for this hop was reviewed; counts + real adds are in `ledger.notes`
- α-normalized coverage vs the **target** `cli.js` is recorded in the ledger (`coverage` field, optional until the matcher lands)
- no hop skipped (88→89→…→112, then 113…)
- hop commit matches the allowlist in `SKILL.md` (no `_snip` / astdiff dumps)

## Ledger shape

See `restore-work/ledgers/_template.json`. Minimum function row:

```json
{
  "id": "stringHash:skeletonHash",
  "class": "small-edit",
  "fromId": "…",
  "srcFile": "src/…",
  "evidence": "string 'defer' + PreToolUse hook shape",
  "rewrittenByLlm": true
}
```

Minimum changelog row:

```json
{
  "item": "Added \"defer\" permission decision to PreToolUse hooks — …",
  "status": "located",
  "evidence": "src/hooks/… + target strings"
}
```
