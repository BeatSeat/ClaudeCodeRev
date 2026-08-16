#!/usr/bin/env node
/**
 * Download restore artifacts (cli.js only) into restore-work/artifacts/.
 *
 *   node fetch-artifacts.mjs --phase official
 *   node fetch-artifacts.mjs --phase cometix --versions 2.1.113,2.1.133
 *   node fetch-artifacts.mjs --phase cometix --all
 *   node fetch-artifacts.mjs --status
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = join(__dir, '..')
const REPO_ROOT = join(SKILL_ROOT, '..', '..', '..')
const ART = join(REPO_ROOT, 'restore-work', 'artifacts')
const INV = join(SKILL_ROOT, 'inventory', 'version-path.json')

function parseArgs(argv) {
  const flags = { phase: null, versions: null, all: false, status: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phase') flags.phase = argv[++i]
    else if (argv[i] === '--versions') flags.versions = argv[++i].split(',').map((s) => s.trim())
    else if (argv[i] === '--all') flags.all = true
    else if (argv[i] === '--status') flags.status = true
  }
  return flags
}

function loadWalk() {
  if (!existsSync(INV)) {
    console.error('Run refresh-inventory.mjs first')
    process.exit(1)
  }
  return JSON.parse(readFileSync(INV, 'utf8'))
}

function cometixSpec(version) {
  const n = Number(String(version).split('.')[2])
  // 2.1.113–2.1.114 shipped cli.js in the wrapper; platform packages start at 2.1.116
  if (n < 116) return `@cometix/claude-code@${version}`
  return `@cometix/claude-code-${process.platform}-${process.arch}@${version}`
}

function extractCliFromTgz(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const tmp = join(tmpdir(), `cc-art-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', tmp], { stdio: 'pipe' })
    const pkg = join(tmp, 'package')
    const cli = join(pkg, 'cli.js')
    if (!existsSync(cli)) throw new Error(`cli.js not in ${tgzPath}`)
    const dest = join(destDir, 'cli.js')
    writeFileSync(dest, readFileSync(cli))
    const meta = {
      extractedAt: new Date().toISOString(),
      bytes: statSync(dest).size,
    }
    const pkgJson = join(pkg, 'package.json')
    if (existsSync(pkgJson)) {
      const pj = JSON.parse(readFileSync(pkgJson, 'utf8'))
      meta.name = pj.name
      meta.version = pj.version
      // Keep full package.json for dependency diffs across hops (gitignored with artifacts/)
      writeFileSync(join(destDir, 'package.json'), readFileSync(pkgJson))
      meta.packageJsonSaved = true
    }
    writeFileSync(join(destDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    return meta
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npmPack(spec, destDir) {
  mkdirSync(destDir, { recursive: true })
  const out = execFileSync(npmBin(), ['pack', spec, '--pack-destination', destDir], {
    encoding: 'utf8',
    timeout: 180_000,
    shell: process.platform === 'win32',
  })
  const name = out.trim().split(/\s+/).pop()
  return join(destDir, name)
}

function alreadyHave(destDir) {
  const cli = join(destDir, 'cli.js')
  const pkg = join(destDir, 'package.json')
  // Require both cli.js and package.json so dependency diffs work without re-pack
  return existsSync(cli) && statSync(cli).size > 1000 && existsSync(pkg)
}

function fetchOne(spec, destDir) {
  if (alreadyHave(destDir)) {
    const bytes = statSync(join(destDir, 'cli.js')).size
    console.log(` [skip] ${spec} (${bytes} bytes + package.json)`)
    return { skipped: true, bytes }
  }
  console.log(` [get]  ${spec}`)
  const packDir = join(ART, '.tmp-pack')
  mkdirSync(packDir, { recursive: true })
  const tgz = npmPack(spec, packDir)
  try {
    const meta = extractCliFromTgz(tgz, destDir)
    console.log(` [ok]   ${spec} → ${meta.bytes} bytes`)
    return meta
  } finally {
    rmSync(tgz, { force: true })
  }
}

function status(pathJson) {
  const rows = []
  for (const step of pathJson.walk) {
    if (!step.artifactSpec) continue
    const dest = join(REPO_ROOT, step.artifactSpec.dest)
    const destDir = dirname(dest)
    const haveCli = existsSync(dest)
    const havePkg = existsSync(join(destDir, 'package.json'))
    rows.push({
      version: step.version,
      phase: step.phase,
      have: haveCli && havePkg,
      haveCli,
      havePkg,
      bytes: haveCli ? statSync(dest).size : 0,
    })
  }
  const have = rows.filter((r) => r.have).length
  const missingOfficial = rows.filter((r) => !r.have && r.phase === 'official-js')
  const missingBridge = rows.filter((r) => !r.have && (r.version === '2.1.113' || r.version === '2.1.133'))
  console.log(
    `Artifacts: ${have}/${rows.length} complete (official incomplete ${missingOfficial.length}, bridge incomplete ${missingBridge.length})`,
  )
  for (const r of [...missingOfficial, ...missingBridge]) {
    console.log(
      `  incomplete ${r.phase} ${r.version} (cli=${r.haveCli}, package.json=${r.havePkg})`,
    )
  }
  return rows
}

const flags = parseArgs(process.argv.slice(2))
const pathJson = loadWalk()

if (flags.status) {
  status(pathJson)
  process.exit(0)
}

const wanted = pathJson.walk.filter((step) => {
  if (!step.artifactSpec) return false
  if (flags.versions) return flags.versions.includes(step.version)
  if (flags.phase === 'official') return step.phase === 'official-js'
  if (flags.phase === 'cometix') {
    if (flags.all) return String(step.phase).startsWith('cometix')
    return step.version === '2.1.113' || step.version === '2.1.133'
  }
  // default: official JS hops + Cometix bridge samples only
  return step.phase === 'official-js' || step.version === '2.1.113' || step.version === '2.1.133'
})

if (wanted.length === 0) {
  console.error('Nothing to fetch. Use --phase official|cometix and optional --versions / --all')
  process.exit(1)
}

let ok = 0
let fail = 0
for (const step of wanted) {
  const destDir = dirname(join(REPO_ROOT, step.artifactSpec.dest))
  const spec = step.phase === 'official-js' ? step.artifactSpec.package : cometixSpec(step.version)
  try {
    fetchOne(spec, destDir)
    ok++
  } catch (e) {
    fail++
    console.error(` [fail] ${spec}: ${e.message}`)
  }
}
console.log(`Done. ok=${ok} fail=${fail}`)
status(pathJson)
