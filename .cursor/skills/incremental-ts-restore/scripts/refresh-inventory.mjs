#!/usr/bin/env node
/**
 * Refresh version lists from npm and rebuild version-path.json.
 * Usage: node refresh-inventory.mjs
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog } from './parse-changelog.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = join(__dir, '..')
const INV = join(SKILL_ROOT, 'inventory')
const REPO_ROOT = join(SKILL_ROOT, '..', '..', '..')

const BASELINE = '2.1.88'
const OFFICIAL_JS_LAST = '2.1.112'
const COMETIX_FIRST = '2.1.113'
const CHECKPOINT = '2.1.133'

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npmJson(args) {
  const out = execFileSync(npmBin(), args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  return JSON.parse(out)
}

function patch(v) {
  return Number(String(v).split('.')[2])
}

function is21(v) {
  return /^2\.1\.\d+$/.test(v)
}

function classifyOfficial(v) {
  if (v === BASELINE) return 'local-baseline'
  const n = patch(v)
  if (n >= 89 && n <= 112) return 'official-cli-js'
  if (n >= 113) return 'official-thin-installer'
  return 'other'
}

function classifyRestoreSource(v) {
  if (v === BASELINE) return 'local-typescript'
  const n = patch(v)
  if (n >= 89 && n <= 112) return 'official-npm-cli.js'
  if (n >= 113) return 'cometix-platform-cli.js'
  return 'unknown'
}

function changelogFor(byVersion, v) {
  const entry = byVersion[v]
  if (!entry) return { present: false, itemCount: 0, items: [] }
  return { present: true, itemCount: entry.itemCount, items: entry.items }
}

const official = npmJson(['view', '@anthropic-ai/claude-code', 'versions', '--json'])
const cometix = npmJson(['view', '@cometix/claude-code', 'versions', '--json'])
mkdirSync(INV, { recursive: true })
writeFileSync(join(INV, 'official-versions.json'), JSON.stringify(official, null, 2) + '\n')
writeFileSync(join(INV, 'cometix-versions.json'), JSON.stringify(cometix, null, 2) + '\n')

const changelogPath = join(INV, 'official-CHANGELOG.md')
if (!existsSync(changelogPath)) {
  console.error('Missing inventory/official-CHANGELOG.md — fetch it first')
  process.exit(1)
}
const parsed = parseChangelog(readFileSync(changelogPath, 'utf8'))
writeFileSync(join(INV, 'changelog-by-version.json'), JSON.stringify(parsed, null, 2) + '\n')

const off21 = official.filter(is21)
const com21 = cometix.filter(is21)
const officialSet = new Set(off21)
const cometixSet = new Set(com21)

const walk = []
walk.push({
  version: BASELINE,
  phase: 'baseline',
  restoreSource: 'local-typescript',
  officialNpm: officialSet.has(BASELINE) ? 'published' : 'unpublished',
  cometixNpm: false,
  changelog: changelogFor(parsed.byVersion, BASELINE),
  notes: 'Local sourcemap-recovered TypeScript tree in this repo. Official npm 404.',
})

for (const v of off21.filter((x) => patch(x) >= 89 && patch(x) <= 112)) {
  walk.push({
    version: v,
    phase: 'official-js',
    restoreSource: classifyRestoreSource(v),
    officialNpm: 'published',
    officialKind: classifyOfficial(v),
    cometixNpm: cometixSet.has(v),
    changelog: changelogFor(parsed.byVersion, v),
    artifactSpec: {
      package: `@anthropic-ai/claude-code@${v}`,
      extract: 'cli.js',
      dest: `restore-work/artifacts/official/${v}/cli.js`,
    },
  })
}

for (const v of com21.filter((x) => patch(x) >= 113)) {
  walk.push({
    version: v,
    phase: v === CHECKPOINT ? 'cometix-checkpoint' : 'cometix-node',
    restoreSource: 'cometix-platform-cli.js',
    officialNpm: officialSet.has(v) ? 'thin-installer' : 'missing',
    cometixNpm: true,
    changelog: changelogFor(parsed.byVersion, v),
    artifactSpec: {
      package: patch(v) < 116 ? `@cometix/claude-code@${v}` : `@cometix/claude-code-win32-x64@${v}`,
      extract: 'cli.js',
      dest: `restore-work/artifacts/cometix/${v}/cli.js`,
      note:
        patch(v) < 116
          ? 'Early Cometix: cli.js is in the wrapper package.'
          : 'Main @cometix/claude-code is a wrapper; JS lives in the platform package.',
    },
    bridge: v === COMETIX_FIRST ? '112-to-113-sea-then-patches' : undefined,
  })
}

const officialJs = walk.filter((x) => x.phase === 'official-js').map((x) => x.version)
const cometixWalk = walk.filter((x) => x.phase.startsWith('cometix')).map((x) => x.version)
const changelogOnly = Object.keys(parsed.byVersion).filter((v) => {
  if (!is21(v)) return false
  const n = patch(v)
  return n >= 88 && n <= 220 && !walk.some((w) => w.version === v)
})

const versionPath = {
  generatedAt: new Date().toISOString(),
  repoRootHint: REPO_ROOT,
  baseline: {
    version: BASELINE,
    kind: 'local-typescript',
    packageJsonVersion: '2.1.88',
    officialNpm: officialSet.has(BASELINE) ? 'published' : 'unpublished-404',
    changelogPresent: Boolean(parsed.byVersion[BASELINE]),
  },
  phases: {
    officialJs: { from: '2.1.89', to: OFFICIAL_JS_LAST, versions: officialJs },
    cometixNode: { from: COMETIX_FIRST, to: cometixWalk.at(-1), checkpoint: CHECKPOINT, versions: cometixWalk },
  },
  switchSourceAt: COMETIX_FIRST,
  checkpointOnly: CHECKPOINT,
  missingOfficialIn88to133: ['2.1.88', '2.1.93', '2.1.95', '2.1.99', '2.1.102', '2.1.103', '2.1.106', '2.1.115', '2.1.125', '2.1.127', '2.1.130'].filter(
    (v) => !officialSet.has(v),
  ),
  official113to133MissingInCometix: off21.filter((v) => patch(v) >= 113 && patch(v) <= 133 && !cometixSet.has(v)),
  changelogHeadingsWithoutWalkEntry: changelogOnly,
  walk,
}

writeFileSync(join(INV, 'version-path.json'), JSON.stringify(versionPath, null, 2) + '\n')
console.log(`Baseline ${BASELINE} officialNpm=${versionPath.baseline.officialNpm}`)
console.log(`Official JS versions: ${officialJs.length} (${officialJs[0]} → ${officialJs.at(-1)})`)
console.log(`Cometix versions: ${cometixWalk.length} (${cometixWalk[0]} → ${cometixWalk.at(-1)})`)
console.log(`Changelog versions parsed: ${parsed.versions.length}`)
console.log(`Wrote ${join(INV, 'version-path.json')}`)
