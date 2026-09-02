# Hop-strict audit (HEAD `128a517` / 2.1.159)

Branch `restore/2.1.131-astdiff` reset to stitched history. 160 WIP restored uncommitted.

## This goal: what was proven and landed

Unique-token owner hop (`bundle 0→N` via `indexOf`) vs `git log -S` first `src/` restore hop.

| token | bundle 0→N | first src hop | SHA |
|---|---|---|---|
| FleetView `isAgentsFleetEnabled` / `leftArrowOpensAgents` / `tengu_slate_meadow` | **119** | **119** | `2a28542` |
| `describe a task for a new session` | **119** | **119** (removed at 141) | `2a28542` → `772fe90` |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` gate flip | **139** | **139** | `a5d521e` |
| `handoffRawMode` | **140** | **140** | `4e2007f` |
| `start a task in the background` / `empty-idle-grace` | **141** | **141** | `772fe90` |
| `writeAuthSnapshot failed:` | **142** | **142** | `60104d2` |
| `tengu_bg_retire_grace_bridged_min` | **149** | **149** | `6c9d8ca` |
| `CLAUDE_CODE_PERFORCE_MODE` / `PERFORCE_READONLY_MESSAGE` | **98** | **98** | `3119ba5` |
| 89 fullscreen default-off (`b4` `return false`) | **89** | **89** | `daa5c4f` |
| 101 plan `On()` + `tengu_ccr_bridge` | **101** | **101** | `7ffa66e` |

119 official gate at 119: `tengu_slate_meadow` default false. 139 flips to env-disable (`!isAgentViewDisabled()`).

## Not proven (goal still open)

1. **Four-domain structural astdiff** for 89–108: `astdiff` binary missing; no `2.1.8*.json` / `2.1.10[0-8].json`. Token scan only.
2. **119 FleetView/daemon** was reconstructed from 159 TS + 119 official gate/strings, **not** a completed 4-domain astdiff review of every add/remove in `2.1.119.json`.
3. Some 119-novel `tengu_bg_*` / `tengu_daemon_*` names exist in TS but were **0 in production dist** at land time (DCE / unused branch).
4. `showThinkingHint` LATE@109 was **false LATE** (109 product). Left at 109.
5. 160 WIP remains uncommitted and must not enter hop commits.

## Backup refs

- Previous HEAD: `backup/8ed8a0f-pre-fleet` (`8ed8a0f`)
- Worktree donor: `/tmp/cc-reorg3` `keep-159-tokens`
- Final stitch: `/tmp/cc-reorg4` `keep-final-159` = `128a517`
