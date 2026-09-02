# 89–108 post-astdiff hop-strict review (read-only)

JSON now exists: `restore-work/diffs/2.1.<ver>.json` (generated Linux astdiff).
Bundles: official `restore-work/artifacts/official/<ver>/cli.js`. From-version is previous walk hop (89 from `local/2.1.88`).
Never `cat`/`rg` `cli.js` — `indexOf`/`slice` only. JSON snippets bleed; re-extract claimed ids by `function Name(` / `var Name=`.

Evaluate **`git show <COMMIT>:src/...` only**. Ignore dirty 160 WIP.

## Current hop SHAs

| ver | SHA |
|---|---|
| 89 | `daa5c4f` |
| 90 | `c610c1d` |
| 91 | `bc6e678` |
| 92 | `ecbd121` |
| 94 | `31d1a00` |
| 96 | `63e8d23` |
| 97 | `a26cb0d` |
| 98 | `3119ba5` |
| 100 | `6a0bef2` |
| 101 | `7ffa66e` |
| 104 | `c110c83` |
| 105 | `9fb6fcd` |
| 107 | `123e3d2` |
| 108 | `38306de` |

## Verdict

`PASS` · `GAPS` · `FAIL`

- PASS: every genuine add/remove/structural product in your domain is at the hop commit or classified (rename-only / vendor / minify / GrowthBook default-false with no unique call-site / absent-in-bundle).
- GAPS: named this-hop 0→N product missing or LATE/EARLY. List minified id, tokens from→to, exact src, verbatim, call sites.
- Skip struct-100-rename, AWS/Azure/MSAL/protobuf vendor.

Known already landed (do not re-report as GAPS): 89 fullscreen `return false`; 91 ultraplan tengu_ultraplan_*; 98 Perforce module; 100 output-efficiency delete; 101 has_explanation / Orphaned worktree / plan `On()`; 108 recap/away-summary tokens.

Write exactly: `## Verdict` `## Findings` `## Verified-correct` `## Missed-product`
