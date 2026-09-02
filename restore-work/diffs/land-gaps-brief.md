# Land astdiff GAPS into hop commits

Work in the assigned **git worktree only**. Do not touch `/root/projects/ClaudeCodeRev` working tree (160 WIP).

Rules:
- Extract official bodies with `indexOf`/`slice` from cometix `cli.js`. Never cat/rg the bundle.
- Do not pull later-hop product (named in each prompt).
- Land call sites, not just helpers.
- Copy strings verbatim from the bundle.
- When done, write `restore-work/diffs/<ver>-<domain>-landing.md` in the **main repo** (`/root/projects/ClaudeCodeRev`) listing files changed and tokens landed.

## 152 worktree: `/tmp/cc-land-152` (commit `b920230`)

Parent 150 `e75010d`. Bundles: `restore-work/artifacts/cometix/2.1.150/cli.js` → `2.1.152/cli.js`.
Reviews: `restore-work/diffs/2.1.152-<domain>-astdiff-review.md`.

Leave 139–151 folded product in place. **Remove 153+ leaks** listed in the reviews (`settleCwdGone`, `enableWorkflows`/`xN`, `skipLfs` on FwH, `spawnedByWorkflowRunId`). Keep 152 `disableWorkflows`.
