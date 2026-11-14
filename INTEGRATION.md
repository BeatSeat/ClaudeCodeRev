# CCR 整体整合版（Claude Code TypeScript restoration）

**生成时间：2026-11-14（+08）**
**基线：Claude Code 2.1.88（`0f326e7a8775b288677fc384b7d3f520d601fec3`）**
**整合主线：2.1.88 → 2.1.190，78 个 restore hop，89 个提交**

> 这不是“已认证的生产版本”。主线是当前能找到的**唯一完整、对象齐全、逐版本连续的源码还原链**；
> 所有 78 个版本在审计里都至少有一项未过，`certified = 0`。用它做后续修复/对账的基线，
> 不要把它当已验证发布。

## 三条历史线

| 线 | 位置 | 覆盖 | 提交数 | 与整合主线的关系 |
|---|---|---|---|---|
| **整合主线** | 本仓库 `master`（源自 `/root/projects/ClaudeCodeRev` 的 `rule10-rebase`） | 2.1.89–2.1.190（78 hop） | 89（含 2.1.88 基线 + chores） | 基准 |
| **旧 GitHub master** | 本仓库 `legacy/master-2.1.183` | 2.1.89–2.1.183（74 hop） | 85 | 2.1.89–2.1.119 的 **24 个树完全一致**；2.1.120 起被改写过，树不同 |
| **09-27 candidate** | 本仓库 `candidates/sprint-30-20260927` | 2.1.89–2.1.128（30 hop） | 30 + 2.1.88 基线 | 另一套独立重建；30 个版本的树**全部**与主线不同 |
| **11-13 r23 pilot** | `integration/pilot-r23-ledgers.json` | 2.1.89–2.1.128（30 分支） | 30 个 ledger 分支 | 分支树是剪枝后的 preaudit 输入，不是完整源码；只保留 commit/ledger 映射作证据 |

## 主线版本表（摘要）

完整 `version -> commit -> tree -> parent` 见 [`integration/manifest.json`](integration/manifest.json)。

| 版本段 | 版本 |
|---|---|
| 2.1.89 – 2.1.128 | 2.1.89, 90, 91, 92, 94, 96, 97, 98, 100, 101, 104, 105, 107, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 119, 120, 121, 122, 123, 126, 128 |
| 2.1.129 – 2.1.160 | 129, 131, 132, 133, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 152, 153, 154, 156, 157, 158, 159, 160 |
| 2.1.161 – 2.1.190 | 161, 162, 163, 165, 166, 167, 169, 170, 172, 173, 174, 175, 176, 178, 179, 181, 183, 185, 186, 187, 190 |

缺失的版本号（2.1.93/95/99/102/103/106/115/124/125/127/130/134/135/151/155/164/168/171/177/180/182）
是 npm 未发布或只有 thin installer 的版本，不是漏做。

## 与另外两条线的比对结论

- **vs 旧 GitHub master**：74 个可比版本中 24 个树相同（全部在 2.1.89–2.1.119）；从 2.1.120 开始
  GitHub 用的是改写过的历史，2.1.184–2.1.190 完全缺失。所以旧 master 不能直接当整合版。
- **vs 09-27 candidate**：30 个版本树全部不同。candidate 线是另一套重建，`sprint-candidate-checks-path-fixed.log`
  显示只有 2.1.119 完整通过 build/typecheck；其余 29 个有 build/typecheck 失败。它是备选/对照，不是替代。
- **vs r23 pilot**：pilot 的 30 个分支是 `PREAUDIT materialized input` 上叠 ledger commit，树是剪枝输入
  （例如 2.1.128 只有 2,369 / 2,536 个 tracked 文件），不是完整源码，不能直接当版本树。
  `integration/pilot-r23-ledgers.json` 保留了 30 个 ledger 与 `version -> tip -> tree -> candidate` 映射。

## 状态与限制

- `summary-remote.json`（09-12 审计）：78 个版本，`build_pass=8`、`version_pass=8`、`help_pass=0`；
  `failed_versions` 列出全部 78 个版本（至少一项未过）。**没有任何版本 certified。**
- 09-27 candidate 线：30 个候选全部 `certification pending`，`candidate_versions_certified=0`。
- r23 pilot（11-13 停止）：30 个 ledger，`certified=false`；9 个 reconcile fail、18 个 pending build、
  3 个 build_failed（2.1.108/120/122 的 chain-wide MemoryWriteSurvey export deadlock）。
- 2.1.191–2.1.239 只有 BeeGFS 侧 artifacts/模块图，**没有源码 commit**；2.1.242+ 是 native binary，
  不在本仓库的 AST/TS 还原范围内。

## 仓库布局

- `master`：整合主线 + 本说明 + `integration/manifest.json` + `integration/pilot-r23-ledgers.json`
- `candidates/sprint-30-20260927`：09-27 的 30 版本 candidate 链
- `legacy/master-2.1.183`：更新前的旧 GitHub master（保留可回溯）
- tag `restore-2.1.190`：整合主线的 2.1.190 restore commit（不含本说明提交）
- tag `legacy-2.1.183`：旧 GitHub master 的 2.1.183 tip

## 验证

```bash
git log --oneline master | head
git show master:integration/manifest.json | head
git log master --format='%H %T %s' | grep 'official 2.1.190'
git rev-list --count master           # 90 = 89 + 本说明提交
```

## 来源

- 整合主线对象库：`/root/projects/ClaudeCodeRev`（`rule10-rebase`，`.git` 约 124 MiB，89 commits）
- 逐版本审计映射：`/root/projects/Zhiman/workspace/ccr_v2_20260912/summary-remote.json`（78 pairs）
- 版本行走清单：`projects/ccr-swarm/validation/real-version-inventory.json`（125 节点，2.1.88–2.1.239）
- 09-27 candidate：`projects/ccr-swarm/production/sprint-30/repo`（`ccr-swarm/candidates/sprint-30`）
- r23 pilot：pod `ccr-r23-pilot-20261107:/state/work-repo` 的 30 个 `refs/heads/ccr-swarm/*`
