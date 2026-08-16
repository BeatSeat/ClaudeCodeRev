---
name: incremental-ts-restore
description: Incrementally restore later Claude Code versions into this 2.1.88 TypeScript tree from official npm cli.js (2.1.89–2.1.112) then Cometix Node-layer cli.js (2.1.113+). Uses AST fingerprints, function ledgers, official CHANGELOG alignment, and hard quality gates. Use when restoring a later version, walking 2.1.89–2.1.220, doing AST diff across bundles, aligning changelog items, or continuing incremental-ts-restore work.
---

# Incremental TypeScript restore

Restore later Claude Code versions **one step at a time** onto this repo's 2.1.88 TypeScript tree. Do not deobfuscate a later bundle from scratch.

## First actions (every run)

1. Read [inventory/version-path.json](inventory/version-path.json) for the walk order and artifact paths.
2. Read that version's block in [inventory/changelog-by-version.json](inventory/changelog-by-version.json). If the JSON is stale, read [inventory/official-CHANGELOG.md](inventory/official-CHANGELOG.md) under `## <version>`.
3. Open `restore-work/ledgers/<fromVersion>.json` (or `_template.json` on the first hop) and `restore-work/ledgers/<version>.json` if it exists.
4. Confirm artifacts exist (`restore-work/artifacts/.../cli.js`). If missing, fetch — do not invent JS.

Refresh data (only when inventory is missing or the user asks):

```bash
node .cursor/skills/incremental-ts-restore/scripts/refresh-inventory.mjs
node .cursor/skills/incremental-ts-restore/scripts/fetch-artifacts.mjs --phase official
node .cursor/skills/incremental-ts-restore/scripts/fetch-artifacts.mjs --phase cometix --versions 2.1.113,2.1.133
```

Skill scripts live under `.cursor/skills/incremental-ts-restore/`. Run them from the **repo root**. First-time: `npm install` in the skill directory (needs `acorn`).

## Version path (do not improvise)

| Phase | Versions | JS source | Notes |
|---|---|---|---|
| Baseline | 2.1.88 | this repo's TypeScript | Official npm unpublished (404) |
| Official JS | 2.1.89 – 2.1.112 | `@anthropic-ai/claude-code` `cli.js` | Still a full bundle |
| Cometix Node | 2.1.113 – latest in inventory | `@cometix/claude-code-<platform>` `cli.js` | Official npm is a thin installer |

- Switch source at **2.1.113**, not 2.1.133. 2.1.133 is a checkpoint only.
- Official 2.1.113+ has **no** analyzable JS. Never `npm pack` those as restore input.
- Cometix **2.1.113–2.1.114**: `cli.js` is in the wrapper `@cometix/claude-code`. **2.1.116+**: use the **platform** package `cli.js`.
- Detail: [reference/version-path.md](reference/version-path.md). Bridge hop: [reference/112-to-113-bridge.md](reference/112-to-113-bridge.md).

## Per-version workflow

Copy this checklist and keep it updated:

```
- [ ] 1. Load fromVersion ledger + target CHANGELOG items
- [ ] 2. Have both cli.js artifacts (or 2.1.88 build output) + package.json
- [ ] 3. Fingerprint both sides
- [ ] 4. classify.mjs → draft ledger; classify every target function
- [ ] 5. Align every CHANGELOG item (no deferred left)
- [ ] 6. LLM only on small-edit / rewrite / added
- [ ] 7. quality-gate.mjs --ledger must pass
```

### 1. Artifacts

- 2.1.88: `bun run build` in this repo → `dist/cli.js` (do not download).
- 2.1.89–2.1.112: `restore-work/artifacts/official/<ver>/cli.js`
- 2.1.113+: `restore-work/artifacts/cometix/<ver>/cli.js`

### 2. Fingerprint

```bash
node .cursor/skills/incremental-ts-restore/scripts/fingerprint.mjs restore-work/artifacts/official/2.1.89/cli.js --out restore-work/ledgers/2.1.89.fp.json
```

Matching rules: [reference/ast-matching.md](reference/ast-matching.md). Classes: `unchanged` | `rename-only` | `small-edit` | `rewrite` | `added` | `removed`.

### 2b. Classify (required)

```bash
node .cursor/skills/incremental-ts-restore/scripts/classify.mjs \
  --from restore-work/ledgers/2.1.88.fp.json \
  --to restore-work/ledgers/2.1.89.fp.json \
  --version 2.1.89 --from-version 2.1.88 \
  --out restore-work/ledgers/2.1.89.json
```

Writes a draft ledger covering every target (+ `removed` from prior). `unchanged` rows are slim. CHANGELOG rows start as `deferred` — resolve before the gate.

### 3. CHANGELOG alignment (required)

For **every** item in `changelog-by-version.json` → `byVersion[ver].items`:

| Status | Meaning |
|---|---|
| `located` | Point to file/function + how the bundle shows it |
| `absent-in-bundle` | Item is docs/packaging/VS Code-only; say why |
| `deferred` | Needs a later hop; record the reason |
| `unrelated-packaging` | Cometix P1–P9 or installer-only |

Do not mark a version done while any item lacks a status. Raw prose: [inventory/official-CHANGELOG.md](inventory/official-CHANGELOG.md).

### 4. Apply TS changes

- `unchanged` / `rename-only`: keep 2.1.88 (or previous hop) TypeScript. No LLM rewrite.
- `small-edit` / `rewrite` / `added`: edit TypeScript using the matched baseline file as the name/structure prior.
- `removed`: delete or stub only with bundle evidence (DCE / feature flag).
- One hop at a time. Do not jump 2.1.88 → 2.1.112.

### 5. Gate

Write `restore-work/ledgers/<ver>.json` from the repo-root template `restore-work/ledgers/_template.json`. Then:

```bash
node .cursor/skills/incremental-ts-restore/scripts/quality-gate.mjs --ledger restore-work/ledgers/<ver>.json
```

If the gate fails, the version is **not done**. Full rules: [reference/quality-gates.md](reference/quality-gates.md).

## Hard rules

1. Never declare done from a skim, a changelog read, or `IMPORT_MAP`-style status.
2. Never LLM-rewrite a function classified `unchanged`.
3. Never use official npm 2.1.113+ as JS input.
4. 2.1.112 → 2.1.113 must keep an **unpatched SEA** `cli.js` in the ledger (`bridge.unpatchedSeaPath`). Compare that to 2.1.112 first; treat Cometix P1–P9 as known noise. See [reference/cometix-patches.md](reference/cometix-patches.md).
5. Function classes in a hop must cover the target fingerprint set (plus `removed` from the previous set).
6. Prefer this repo's `scripts/build.ts` for the 2.1.88 control bundle.

## Scripts

| Script | Run when |
|---|---|
| `scripts/refresh-inventory.mjs` | Refresh npm lists + rebuild `version-path.json` |
| `scripts/parse-changelog.mjs` | Re-parse CHANGELOG only |
| `scripts/fetch-artifacts.mjs` | Download `cli.js` + `package.json` (`--status` to see gaps) |
| `scripts/fingerprint.mjs` | Build function fingerprints |
| `scripts/classify.mjs` | Auto-classify from→to fingerprints into a draft ledger |
| `scripts/quality-gate.mjs` | Before calling a hop complete |

## Layout

```
.cursor/skills/incremental-ts-restore/   this skill
inventory/                               CHANGELOG + version path (read these)
restore-work/artifacts/                  downloaded cli.js (gitignored)
restore-work/ledgers/                    per-version ledgers (keep in git)
```
