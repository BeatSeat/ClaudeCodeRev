# Land remaining 89–108 astdiff GAPS

Worktree only: `/tmp/cc-reorg5`. Do **not** edit `/root/projects/ClaudeCodeRev/src/**` (160 WIP + conflict markers).

Start: `git worktree add /tmp/cc-reorg5 c610c1d` (90). Cherry-pick each hop, fold GAPS into the owner hop, then cherry-pick through 159 (`128a517` lineage).

Official bundles: `restore-work/artifacts/official/<ver>/cli.js`. `indexOf`/`slice` only.

## Must land (bundle 0→N verified by main agent)

### 91 `bc6e678` — FileWrite append
Tokens 90→91: `tengu_maple_forge_w8k` 0→2, `mode:'append'` 0→2, `to append with mode` 0→1.
Official `_tq()`: GB `tengu_maple_forge_w8k` default false; when true, Write prompt adds append usage + “or to append with mode:'append'”.
Land: `src/tools/FileWriteTool/prompt.ts` `getWriteToolDescription` + schema `mode: 'append'` on FileWriteTool if official 91 input schema has it. Extract `function _tq(` from official 91.

### 92 `ecbd121` — `CLAUDE_CODE_EXECPATH`
Tokens 91→92: `CLAUDE_CODE_EXECPATH` 0→1.
Official `Ge1="CLAUDE_CODE_EXECPATH"` in shell snapshot argv0 + bash provider `w[Ge1]=process.execPath`.
Land at 92 (today LATE 108):
- `src/utils/bash/ShellSnapshot.ts` `createArgv0ShellFunction`: `_cc_bin="${CLAUDE_CODE_EXECPATH:-}"`
- `src/utils/shell/bashProvider.ts` env `CLAUDE_CODE_EXECPATH: process.execPath`
Copy the two hunks from `128a517` / current HEAD if 92 files already have argv0 without the env.

### 94 `31d1a00` — Autofix PR errors
Tokens 92→94: `tengu_autofix_pr_result` 0→3, `Autofix PR failed:` 0→1, `cannot run on the default branch` 0→1, `gh CLI is required but not found` 0→1.
`src/commands/autofix-pr/index.ts` is a stub. Extract official 94 function around `tengu_autofix_pr_result` and land real body + call site. Do **not** wait for 101.

### 98 `3119ba5` — Monitor tool
Tokens 97→98: `tengu_amber_sentinel` 0→1, `Start a background monitor that streams` 0→1, `MonitorTool` 0→3.
Hop 98 still stub; full-ish tool LATE 108 but missing `prompt.ts`/`UI.tsx`.
Land 98-era Monitor: gate `getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_sentinel', false)`, official prompt string verbatim, register tool. Extract official 98 `function Gs(` / Monitor prompt.

### 101 `7ffa66e` — cloud-first + UI/services LATE@108
Tokens 100→101 official (not JSON bleed):
- `Offer cloud first` 0→1, `Cloud schedule (recommended)` 0→1, `tengu_cinder_almanac` 0→2
- UI LATE@108 (checkout these hunks from `38306de` into 101 if they exist there): `urlOutdent` ConsoleOAuthFlow, `renderItemRef` VirtualMessageList, LogSelector Space preview, log-update skip, parse-keypress C0 `\\` `]` `^`

## Do not
- 160 ultracode / DesignSync
- 119 FleetView rewrite in this pass unless cherry-pick conflicts
- Force-push

Write `/root/projects/ClaudeCodeRev/restore-work/diffs/2.1.89-108-gaps-landing.md` with new SHAs and tokens.
