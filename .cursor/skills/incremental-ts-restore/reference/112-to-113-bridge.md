# 2.1.112 → 2.1.113 bridge

Hardest hop. Three artifacts, not two.

1. **Official 2.1.112** `cli.js` — last full npm JS.
2. **Unpatched SEA** `cli.js` from the 2.1.113 Bun binary (`src/entrypoints/cli.js` inside the extract). Not in npm.
3. **Cometix patched** `cli.js` from `@cometix/claude-code-<platform>@2.1.113`.

## Required order

1. Fingerprint 112 vs unpatched 113. Classify product changes. Align CHANGELOG `## 2.1.113` (first item is the native-binary spawn — that is packaging; status `unrelated-packaging` or `absent-in-bundle` for the JS tree).
2. Fingerprint unpatched 113 vs Cometix 113. Remaining deltas must map to P1–P9 ([cometix-patches.md](cometix-patches.md)).
3. Ledger must set `bridge.unpatchedSeaPath`. `quality-gate.mjs` fails 2.1.113 without it.

## How to get the unpatched SEA file

Cometix repo: `node scripts/fetch-and-process.mjs --version 2.1.113` (needs the official Darwin/Linux/Windows SEA from `https://downloads.claude.ai/claude-code-releases/2.1.113/manifest.json`).

Keep a copy at `restore-work/artifacts/sea/2.1.113/cli.js` (unpatched). Do not overwrite it with the Cometix patched file.

This skill does not yet vendor the SEA extractor. If the unpatched file is missing, stop and obtain it; do not pretend 112 vs patched-113 is a clean product diff.
