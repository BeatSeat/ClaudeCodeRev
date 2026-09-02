# Post-rewrite astdiff re-audit

History was rewritten so 154/157 GAPS live in those hops and 139–152 backfills were folded into 152. This wave evaluates **the new hop commits**, not old `0391ea1`.

## Rules

- Do **not** edit `src/**`. Only write your assigned `restore-work/diffs/<ver>-<domain>-astdiff-review.md`.
- Do **not** start another version’s land. Do **not** pull later-hop behavior.
- Ignore uncommitted working-tree dirt (160 ultracode / DesignSync). Evaluate **`git show <COMMIT>:src/...` only**.
- Bundles are **one line**. Never `cat` / `head` / `rg` `cli.js`. Extract windows with `indexOf`/`slice`.
- astdiff JSON snippets **bleed**. Re-extract every claimed id by `function Name(` / `var Name=`.
- Skip `struct-100-rename`, vendor, Growthbook default-false with no call sites.
- Ast-only product (unique 0→N string, no CHANGELOG) still counts in your domain.

## Report headings (required)

```
## Verdict
## Findings
## Verified-correct
## Missed-product
```

Verdict is exactly one of: `PASS` · `FAIL` · `GAPS`.

- **PASS**: every genuine add/remove/structural edit in this domain is landed at the hop commit or classified (rename-only / vendor / minify / absent-in-bundle / vscode-host / later-hop).
- **GAPS**: named product of **this hop** is missing at the hop commit (list minified id, tokens from→to, exact src, verbatim change, call sites).
- **FAIL**: cannot finish, or a claimed landing is wrong vs the bundle.

Also flag **wrong-hop leak**: product whose unique token first appears in a **later** bundle is present in this hop commit.

Silent/empty file is FAIL.

## Domain fences

| domain | dirs | also |
|---|---|---|
| ui | `src/ink/`, `src/components/`, `src/screens/` except REPL.tsx | vim/hooks only if the CHANGELOG row is UI |
| tools | `src/tools/`, `src/utils/permissions/`, `src/utils/sandbox/` | |
| core | `src/bridge/`, `src/state/`, `src/types/`, `src/screens/REPL.tsx` | effort, workflows/keyword, daemon/bg session, messages |
| services | `src/services/`, `src/utils/telemetry/`, `src/utils/plugins/` | |

Index: `restore-work/diffs/<ver>-index/`. Dump: `restore-work/diffs/<ver>.astdump`.
