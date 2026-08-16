# Inventory (read by the skill)

| File | What |
|---|---|
| `official-CHANGELOG.md` | Full official changelog from `anthropics/claude-code` |
| `changelog-by-version.json` | Same text split by `## x.y.z` |
| `version-path.json` | Walk order, artifact specs, changelog presence |
| `official-versions.json` | Raw `npm view @anthropic-ai/claude-code versions` |
| `cometix-versions.json` | Raw `npm view @cometix/claude-code versions` |

Refresh: `node scripts/refresh-inventory.mjs` from this skill directory (or via the path in SKILL.md).
