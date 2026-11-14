# restore-work

Working tree for `incremental-ts-restore`. Skill: `.cursor/skills/incremental-ts-restore/`.

```
restore-work/
  artifacts/official/<ver>/cli.js         official npm JS (2.1.89–2.1.112)
  artifacts/official/<ver>/package.json   official deps for that hop
  artifacts/cometix/<ver>/cli.js          Cometix platform JS (2.1.113+)
  artifacts/sea/2.1.113/cli.js            unpatched Bun SEA (required for 112→113)
  ledgers/<ver>.json                      per-hop classification + CHANGELOG coverage
  ledgers/<ver>.fp.json                   fingerprint output
```

`artifacts/` is gitignored. `ledgers/` is kept.

Classify draft:

```bash
node .cursor/skills/incremental-ts-restore/scripts/classify.mjs \
  --from restore-work/ledgers/<from>.fp.json \
  --to restore-work/ledgers/<ver>.fp.json \
  --version <ver> --from-version <from> \
  --out restore-work/ledgers/<ver>.json
```
