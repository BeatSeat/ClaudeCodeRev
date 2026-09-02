# Hop-strict remaining vs astdiff (HEAD `8ed8a0f` / 2.1.159)

Goal: every `restore: align TypeScript tree with official <ver>` must match that hop’s bundle 0→N (astdiff / unique-token owner). CHANGELOG announcement hop does **not** override a 0→N owner.

## Proven mismatch (must fix)

### 2.1.119 FleetView + daemon/bg — LATE 139

Cometix `2.1.118` → `2.1.119` unique product (indexOf). TS first appearance is `f830b00` (139) except the 119 placeholder string.

| token | 118→119 | first `src/` hop |
|---|---|---|
| `isAgentsFleetEnabled` | 0→3 | 139 |
| `mountFleetView` | 0→3 | 139 |
| `leftArrowOpensAgents` | 0→11 | **never in src** |
| `tengu_fleetview` | 0→2 | 139 |
| `tengu_bg_*` (21 names) | 0→N | 139 |
| `tengu_daemon_*` (11 names) | 0→N | 139 |
| `tengu_open_agents_via_left` / `tengu_fg_left_arrow_agents` | 0→1 | missing |
| `claude agents` | 0→4 | 139 cli path |
| `CLAUDE_CODE_SESSION_KIND` | 0→6 | 139 |
| `describe a task for a new session` | 0→1 | 119 `placeholders.ts` only |

119 official gate (`CZH` / `bZH` / `qqH` / `b_8`):

```
isAgentsFleetEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_meadow', false)
isFgLeftArrowAgentsAvailable = isAgentsFleetEnabled() && getFeatureValue_CACHED_MAY_BE_STALE('tengu_fg_left_arrow_agents', false)
isDaemonCliEnabled = () => false
fleetGateRejected: `'${flag}' is not available in this release.`
```

Current TS `fleetGate.ts` is **139-era** (env `CLAUDE_CODE_DISABLE_AGENT_VIEW` 0→2 at **139**, always-on unless disabled). That gate flip stays at 139. The UI/daemon bodies belong at 119.

119 hop currently has only `src/components/FleetView/placeholders.ts`. Full tree is at 139.

Do **not** pull these later unique tokens into 119:

| token | owner |
|---|---|
| `handoffRawMode` | 140 |
| `start a task in the background` | 141 |
| `empty-idle-grace` | 141 |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` | 139 |
| `writeAuthSnapshot failed:` / `CLAUDE_BG_AUTH_SNAPSHOT_PATH` | 142 |
| `tengu_bg_retire_pinned_low_mem` | 147 |
| `tengu_bg_retire_grace_bridged_min` | 149 |

## Other remaining (not yet re-proven this turn)

- **89–108**: no `restore-work/diffs/2.1.8*.json` / `2.1.10[0-8].json`; `astdiff` binary missing. Token hop-strict extras were scanned earlier; **four-domain structural review never ran**.
- **119–138 later growth** of `tengu_bg_` / `fleetview` counts (119:50 → 138:119) must stay on the hop where each name goes 0→N, not dumped into 119.
- **132** `tengu_goal_achieved` helper is at 132; full `/goal` UI still 139 (CHANGELOG + 139-unique overlay). Keep unless 118→132 astdiff shows the overlay earlier.
- **160 WIP** is uncommitted and must not enter hop commits.

## Method for the 119 rewrite

Worktree only. Replay from 118 `81b36a9`. Land 119-era FleetView + daemon at 119. Replay 120–138. 139 keeps `/goal` + `/scroll-speed` + `CLAUDE_CODE_DISABLE_AGENT_VIEW` gate flip; do not re-add FleetView/daemon files. 140–159 keep their later-token patches. Restore 160 WIP onto the new 159.
