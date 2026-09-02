# Post-commit astdiff audit (154 / 156 / 157 / 158 / 159)

These hops were committed **without** usable astdiff (`using` parse fail). Linux astdiff was backfilled later. This wave is **read-only review**, not a new hop.

## Rules

- Do **not** edit `src/**`. Only write your assigned `restore-work/diffs/<ver>-<domain>-astdiff-review.md`.
- Do **not** start another version’s land. Do **not** pull 2.1.160+ behavior.
- Ignore uncommitted working-tree dirt (DesignSync, ultracode violet, etc.). That is 160. Evaluate **git HEAD** `0391ea1` (`package.json` 2.1.159).
- Bundles are **one line**. Never `cat` / `head` / `rg` `cli.js`. Extract windows:

```bash
node -e 'const fs=require("fs"); const s=fs.readFileSync("restore-work/artifacts/cometix/2.1.154/cli.js","utf8");
const i=s.indexOf("function NAME("); console.log(s.slice(i, Math.min(s.length,i+1200)));'
```

Token counts on **both** from and to:

```bash
node -e 'const fs=require("fs");
const c=(f,t)=>{const s=fs.readFileSync(f,"utf8"); let n=0,i=-1; while((i=s.indexOf(t,i+1))!==-1)n++; return n};
const a="restore-work/artifacts/cometix/FROM/cli.js";
const b="restore-work/artifacts/cometix/TO/cli.js";
for (const t of ["TOKEN"]) console.log(t, c(a,t), "→", c(b,t));'
```

- astdiff JSON snippets **bleed**. Re-extract every claimed id by `function Name(` / `var Name=`.
- Skip `struct-100-rename`, vendor (AWS/Azure/MSAL/protobuf), Growthbook default-false with no call sites.
- **Ast-only product** (unique 0→N string, no CHANGELOG line) still counts if it is in your domain.

## Report headings (required)

```
## Verdict
## Findings
## Verified-correct
## Missed-product
```

`## Verdict` is exactly one of: `PASS` · `FAIL` · `GAPS`.

- **PASS**: every genuine add/remove/structural edit in this domain is landed at HEAD or classified (rename-only / vendor / minify / absent-in-bundle / vscode-host).
- **GAPS**: named product is missing at HEAD and should be backfilled (list minified id, tokens from→to, exact src, verbatim change, call sites).
- **FAIL**: cannot finish, or a claimed landing is wrong vs the bundle.

Silent/empty file is FAIL. Write the file even if the domain is empty (`PASS` + why).

## Domain fences

| domain | dirs | also |
|---|---|---|
| ui | `src/ink/`, `src/components/`, `src/screens/` except REPL.tsx | vim/hooks only if the CHANGELOG row is UI |
| tools | `src/tools/`, `src/utils/permissions/`, `src/utils/sandbox/` | |
| core | `src/bridge/`, `src/state/`, `src/types/`, `src/screens/REPL.tsx` | effort, workflows/keyword, daemon/bg session, messages |
| services | `src/services/`, `src/utils/telemetry/`, `src/utils/plugins/` | |

Index: `restore-work/diffs/<ver>-index/` (`added-product.json`, `genuine-structural.json`, `string-product.json`, `counts.json`). Dump: `restore-work/diffs/<ver>.astdump`.
