# Version path

Read [inventory/version-path.json](../inventory/version-path.json) as the live list. This file explains the rules behind it.

## Why 2.1.113, not 2.1.133

Official `@anthropic-ai/claude-code@2.1.112` still ships a ~49 MB `cli.js`.

Official `@2.1.113` and later are ~132 KB thin installers (`bin/claude.exe`). There is no JS to restore from.

[CometixSpace/claude-code](https://github.com/CometixSpace/claude-code) extracts Bun SEA binaries and publishes a Node-runnable `cli.js` on `@cometix/claude-code-<os>-<cpu>`. That series starts at **2.1.113**.

2.1.133 is only a checkpoint (first-stage acceptance), not the source switch.

## Baseline 2.1.88

This repo is the sourcemap-recovered TypeScript for 2.1.88. Official npm returns 404 for `@anthropic-ai/claude-code@2.1.88`. Do not try to pack it.

Control bundle: `bun run build` → `dist/cli.js`.

## Official JS hops (2.1.89–2.1.112)

Package: `@anthropic-ai/claude-code@<ver>`
Extract: `cli.js` → `restore-work/artifacts/official/<ver>/cli.js`

Skipped npm numbers in this range (not published): 93, 95, 99, 102, 103, 106. Walk the published list only.

## Cometix hops (2.1.113+)

- **2.1.113–2.1.114:** `cli.js` is inside the wrapper `@cometix/claude-code@<ver>` (~44 MB unpacked). No platform packages yet.
- **2.1.116+:** `cli.js` is in `@cometix/claude-code-<platform>@<ver>`. The wrapper is small.

Extract: `cli.js` → `restore-work/artifacts/cometix/<ver>/cli.js`

`fetch-artifacts.mjs` picks the wrapper before 2.1.116 and `process.platform-process.arch` after. On this machine that is `win32-x64`.

Official 2.1.124 exists as a thin installer; Cometix has no 2.1.124. Skip it.

## CHANGELOG vs npm

Official [CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) is mirrored at [inventory/official-CHANGELOG.md](../inventory/official-CHANGELOG.md). Some headings have no matching npm tarball (unpublished / skipped). Still align those items on the next published hop if the text landed there.

2.1.88 has **no** `## 2.1.88` heading in the current changelog. Start alignment at 2.1.89.
