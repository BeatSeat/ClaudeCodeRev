# astdiff scout: 2.1.108 → 2.1.114

Fresh `--summary` against on-disk artifacts (2026-08-22). Official 112 vs Cometix 113 is **not** a clean product hop.

| Hop | Similarity | Added | Removed | Structural | String-only | Changelog items | Size class |
|---|---|---|---|---|---|---|---|
| official 108 → 109 | 100.0% | +8 | -6 | 6910 | 59 | 1 (rotating thinking hint) | small product |
| official 109 → 110 | 98.7% | +245 | -59 | 7895 | 56 | 33 (`/tui`, `/focus`, push, …) | large |
| official 110 → 111 | 99.2% | +155 | -78 | 7529 | 54 | 35 (Opus 4.7 xhigh, `/ultrareview`, …) | large |
| official 111 → 112 | 100.0% | +4 | -3 | 3854 | 57 | 1 (opus-4-7 auto-mode unavailable) | small product |
| official 112 vs cometix 113 | 88.9% | +2251 | -1595 | 9280 | 43 | 38 + packaging + Cometix P1–P9 | **do not use as hop** |
| cometix 113 → 114 | 100.0% | +0 | -0 | 25 | 47 | 1 (permission-dialog crash) | smallest |

Walk decision (skill: no skipped published hops):

1. Finish **109** (small, already landed in REPL).
2. Walk **110** then **111** (large, required).
3. Finish **112** (small).
4. **113** only via unpatched SEA vs official 112, then SEA vs Cometix 113. SEA artifact is currently missing (`restore-work/artifacts/sea/2.1.113/cli.js`).
5. **114** is the cleanest post-113 hop.

Evolution that is easy to see in astdiff: 108→109 thinking-hint wrapper; 111→112 auto-mode string/model fix; 113→114 single permission-dialog crash. Official 112 vs Cometix 113 is the bun/installer cliff, not a readable product delta.
