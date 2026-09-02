# Re-audit dispatch (read with astdiff-reaudit-brief.md)

Repo: `/root/projects/ClaudeCodeRev`

CHANGELOG: `.cursor/skills/incremental-ts-restore/inventory/changelog-by-version.json` and `inventory/official-CHANGELOG.md`.

Extract recipe (never cat/rg cli.js):

```bash
node -e 'const fs=require("fs"); const s=fs.readFileSync("BUNDLE","utf8");
const i=s.indexOf("function NAME("); console.log(s.slice(i, Math.min(s.length,i+1200)));'
```

Token counts:

```bash
node -e 'const fs=require("fs");
const c=(f,t)=>{const s=fs.readFileSync(f,"utf8"); let n=0,i=-1; while((i=s.indexOf(t,i+1))!==-1)n++; return n};
for (const t of ["TOKEN"]) console.log(t, c("FROM","TOKEN"), "→", c("TO","TOKEN"));'
```

TS: `git show <COMMIT>:path` only. Working tree is 160 dirt.

## Hops

| ver | COMMIT | parent | from bundle | to bundle | named risk |
|---|---|---|---|---|---|
| 2.1.154 | `609a918` | `de1f84f` | `restore-work/artifacts/cometix/2.1.153/cli.js` | `restore-work/artifacts/cometix/2.1.154/cli.js` | Discover `wk8`/`Dk8` pin; Chrome `Un4` picker; Opus `opus48LaunchSeenCount`/`DKz=8`/`LKz`/`PKz`; help `& for background` removed; wrap strip space; `unpinOpus48LaunchEffort`; `modelSupportsEffort` A2 + ALWAYS_ENABLE after denylist; cutoff opus-4-8 Jan 2026; TMPDIR always sandboxTmpDir; classifier 8192; `xw7` defaultEnabled; mcp `includePendingProjectServers`; `V71`; lean `c45`/`X3`. Must NOT contain 157 fotw/orphaned_on_resume/`classifySandboxNetworkAccess` or 160 ultracode. |
| 2.1.156 | `55dc5d7` | `609a918` | `…/2.1.154/cli.js` | `…/2.1.156/cli.js` | Small hop (index total 151). Confirm only 156 product. No 157/160 leak. |
| 2.1.157 | `783f5a2` | `55dc5d7` | `…/2.1.156/cli.js` | `…/2.1.157/cli.js` | `/model` `Yr_` slogans; FotW `fotw-claim`; `/plugin` `getArgumentCompletions`; `orphaned_on_resume`; worktree unlock-first / linked `--worktree` / no resume `utimes` / `job_retention_sweep`; `nT9` sandbox wrap (do not reuse `shouldAutoApproveSandboxNetwork`; auto→classify); EnterWorktree mid-session; image `Ev` catch. Must NOT contain 160 ultracode/DesignSync. Sandbox startup banner must be **gone** in this commit (154/156 still have it). |
| 2.1.158 | `5e5e2ae` | `783f5a2` | `…/2.1.157/cli.js` | `…/2.1.158/cli.js` | Prior PASS: `src/services/api/claude.ts` + `src/utils/betas.ts`. Confirm hop-strict. |
| 2.1.159 | `1df7391` | `5e5e2ae` | `…/2.1.158/cli.js` | `…/2.1.159/cli.js` | Prior PASS; hop is mostly ledger/reviews. Confirm no missing 159 product and no 160 leak. |

## Attribution hop (139–152)

Original 152: `3ccef05`. Folded 152': `b920230`. Parent of 152': `e75010d` (150).

139–151 commits (unchanged):

| ver | COMMIT |
|---|---|
| 139 | `9ffe684` |
| 140 | `c7fe9ad` |
| 141 | `31c4f72` |
| 142 | `3bccc1a` |
| 143 | `55b9995` |
| 144 | `f5ff920` |
| 145 | `44a93f7` |
| 146 | `364797d` |
| 147 | `2913664` |
| 148 | `090b7b8` |
| 149 | `6c232f0` |
| 150 | `e75010d` |

Write `restore-work/diffs/2.1.139-152-backfill-attribution.md`: for every **src/** path that is in `b920230` but not in `3ccef05` (the fold), and for unique product strings in those files, count the token in cometix bundles 2.1.138 through 2.1.152. Assign the **first hop where the unique token appears** (`0→N`). List files that belong in 139, 140, … 152 respectively. Do not edit `src/**`.
