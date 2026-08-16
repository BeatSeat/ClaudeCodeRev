#!/usr/bin/env node
/**
 * Hard gate before declaring a version restore done.
 *
 *   node quality-gate.mjs --ledger restore-work/ledgers/2.1.89.json
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = join(__dir, '..')
const INV = join(SKILL_ROOT, 'inventory')

const CLASSES = new Set(['unchanged', 'rename-only', 'small-edit', 'rewrite', 'added', 'removed'])

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const flags = { ledger: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ledger') flags.ledger = argv[++i]
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
if (!flags.ledger || !existsSync(flags.ledger)) {
  console.error('Usage: node quality-gate.mjs --ledger <ledger.json>')
  process.exit(1)
}

const ledger = JSON.parse(readFileSync(flags.ledger, 'utf8'))
const changelog = JSON.parse(readFileSync(join(INV, 'changelog-by-version.json'), 'utf8'))
const pathJson = JSON.parse(readFileSync(join(INV, 'version-path.json'), 'utf8'))

if (!ledger.version || !ledger.fromVersion) fail('ledger needs version and fromVersion')
if (!Array.isArray(ledger.functions)) fail('ledger.functions must be an array')

const counts = Object.fromEntries([...CLASSES].map((k) => [k, 0]))
for (const [i, fn] of ledger.functions.entries()) {
  if (!CLASSES.has(fn.class)) fail(`functions[${i}] invalid class ${fn.class}`)
  counts[fn.class]++
  if ((fn.class === 'added' || fn.class === 'rewrite' || fn.class === 'small-edit') && !fn.evidence) {
    fail(`functions[${i}] class=${fn.class} missing evidence`)
  }
  if (fn.class === 'unchanged' && fn.rewrittenByLlm) {
    fail(`functions[${i}] marked unchanged but rewrittenByLlm=true`)
  }
}

const expected = ledger.expectedFunctionCount
if (typeof expected === 'number' && ledger.functions.length !== expected) {
  fail(`function count ${ledger.functions.length} != expectedFunctionCount ${expected}`)
}

const cl = changelog.byVersion[ledger.version]
if (cl && Array.isArray(ledger.changelogCoverage)) {
  const covered = new Set(ledger.changelogCoverage.map((c) => c.item))
  for (const item of cl.items) {
    if (!covered.has(item)) fail(`changelog item not in coverage: ${item.slice(0, 80)}`)
  }
  for (const row of ledger.changelogCoverage) {
    if (!row.status || !['located', 'absent-in-bundle', 'deferred', 'unrelated-packaging'].includes(row.status)) {
      fail(`bad changelog coverage status: ${row.status}`)
    }
    if (row.status === 'located' && !row.evidence) fail(`located changelog item missing evidence`)
  }
} else if (cl && cl.itemCount > 0 && !ledger.changelogCoverage) {
  fail(`version ${ledger.version} has ${cl.itemCount} changelog items but no changelogCoverage`)
}

const step = pathJson.walk.find((w) => w.version === ledger.version)
if (step?.bridge === '112-to-113-sea-then-patches') {
  if (!ledger.bridge || !ledger.bridge.unpatchedSeaPath) {
    fail('2.1.113 ledger must record bridge.unpatchedSeaPath (SEA before Cometix patches)')
  }
}

console.log(JSON.stringify({ version: ledger.version, functions: ledger.functions.length, counts }, null, 2))
if (process.exitCode) {
  console.error('quality-gate failed')
  process.exit(1)
}
console.log('quality-gate passed')
