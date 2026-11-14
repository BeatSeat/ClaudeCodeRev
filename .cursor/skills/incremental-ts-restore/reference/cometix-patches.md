# Cometix patches (known noise)

Source: [CometixSpace/claude-code](https://github.com/CometixSpace/claude-code) `scripts/node-compat-patch.mjs`. These are **not** Anthropic product changes.

When comparing Cometix↔Cometix, strip or ignore these sites before classifying `small-edit`.

When comparing official 2.1.112 ↔ Cometix 2.1.113, compare **unpatched SEA** `cli.js` first, then record P1–P9 as `unrelated-packaging`.

| Id | What |
|---|---|
| P1 | `fileURLToPath("file:///…/claude-cli-internal/…")` → `__filename`; same for `createRequire` |
| P2 | `typeof Bun > "u"` throw → `return null` |
| P3 | `require("/$bunfs/root/…")` → `vendor/` fallback |
| P5 | Restore `EMBEDDED_SEARCH_TOOLS` env (Bun inlined `"true"`) |
| P6 | Inject Bun polyfill if `typeof Bun` guards are scarce |
| P7 | Expose `HttpsProxyAgent` on `globalThis` |
| P8 | Shadow `bfs`/`ugrep` via `which`/`where` |
| P9 | `@anthropic-ai/claude-code` → `@cometix/claude-code` |

Also: strip `// @bun @bytecode @bun-cjs` wrapper and the CJS IIFE before fingerprinting Cometix/SEA files (`stripBunWrapper` in their patcher).
