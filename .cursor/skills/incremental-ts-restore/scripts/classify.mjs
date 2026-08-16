#!/usr/bin/env node
/**
 * Classify every target fingerprint against a previous (from) fingerprint set.
 *
 *   node classify.mjs \
 *     --from restore-work/ledgers/2.1.88.fp.json \
 *     --to   restore-work/ledgers/2.1.89.fp.json \
 *     --version 2.1.89 --from-version 2.1.88 \
 *     --out restore-work/ledgers/2.1.89.json \
 *     [--src src]
 *
 * Classes: unchanged | rename-only | small-edit | rewrite | added | removed
 * unchanged rows are slim (id/class/fromId/srcFile only).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = join(__dir, '..')
const REPO_ROOT = join(SKILL_ROOT, '..', '..', '..')
const INV = join(SKILL_ROOT, 'inventory', 'changelog-by-version.json')

function parseArgs(argv) {
  const flags = {
    from: null,
    to: null,
    out: null,
    version: null,
    fromVersion: null,
    src: join(REPO_ROOT, 'src'),
    slimUnchanged: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') flags.from = argv[++i]
    else if (a === '--to') flags.to = argv[++i]
    else if (a === '--out') flags.out = argv[++i]
    else if (a === '--version') flags.version = argv[++i]
    else if (a === '--from-version') flags.fromVersion = argv[++i]
    else if (a === '--src') flags.src = argv[++i]
    else if (a === '--full-unchanged') flags.slimUnchanged = false
  }
  return flags
}

function fnId(fn) {
  return `${fn.stringHash}:${fn.skeletonHash}`
}

function jaccard(a, b) {
  if (!a.length && !b.length) return 1
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

function sharedAnchorCount(a, b) {
  const B = new Set(b)
  let n = 0
  for (const s of a) {
    if (s.length >= 8 && B.has(s)) n++
  }
  return n
}

function walkTsFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      walkTsFiles(p, out)
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

/** Map distinctive strings (>=12 chars) → likely src files (first few hits). */
function buildStringIndex(srcRoot) {
  const index = new Map()
  const files = walkTsFiles(srcRoot)
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    // crude string literal scrape
    const re = /(['"`])((?:\\.|(?!\1).){12,}?)\1/g
    let m
    while ((m = re.exec(text)) !== null) {
      const s = m[2]
      if (s.length > 200) continue
      if (!index.has(s)) index.set(s, [])
      const list = index.get(s)
      if (list.length < 5 && !list.includes(rel)) list.push(rel)
    }
  }
  return index
}

function guessSrcFile(fn, stringIndex) {
  if (!fn.strings?.length) return null
  const votes = new Map()
  for (const s of fn.strings) {
    if (s.length < 12) continue
    const hits = stringIndex.get(s)
    if (!hits) continue
    for (const f of hits) votes.set(f, (votes.get(f) || 0) + 1)
  }
  let best = null
  let bestN = 0
  for (const [f, n] of votes) {
    if (n > bestN) {
      best = f
      bestN = n
    }
  }
  return bestN >= 2 ? best : best
}

function classifyPair(fromFn, toFn) {
  const sameStrings = fromFn.stringHash === toFn.stringHash
  const sameSkel = fromFn.skeletonHash === toFn.skeletonHash
  if (sameStrings && sameSkel) {
    const nameChanged =
      fromFn.name && toFn.name && fromFn.name !== toFn.name
    if (nameChanged) {
      return {
        class: 'rename-only',
        evidence: `name ${fromFn.name} → ${toFn.name}; same string+skeleton hash`,
      }
    }
    return { class: 'unchanged' }
  }
  // same content hashes but we already handled; skeleton-only / string-only
  if (sameSkel && sameStrings) return { class: 'unchanged' }

  const overlap = jaccard(fromFn.strings || [], toFn.strings || [])
  const anchors = sharedAnchorCount(fromFn.strings || [], toFn.strings || [])

  if (sameSkel && !sameStrings && overlap >= 0.85) {
    return {
      class: 'small-edit',
      evidence: `same skeletonHash; string Jaccard=${overlap.toFixed(3)}; anchors=${anchors}`,
    }
  }
  if (sameStrings && !sameSkel) {
    // identical string set, structure changed → rewrite (or small if tiny)
    return {
      class: 'rewrite',
      evidence: `same stringHash; skeleton ${fromFn.skeletonHash}→${toFn.skeletonHash}`,
    }
  }
  if (overlap >= 0.55 && anchors >= 2) {
    // high overlap → small-edit; medium with few anchors still small if overlap high
    if (overlap >= 0.75 || (overlap >= 0.55 && anchors >= 4)) {
      return {
        class: 'small-edit',
        evidence: `string Jaccard=${overlap.toFixed(3)}; anchors=${anchors}; skel ${fromFn.skeletonHash}→${toFn.skeletonHash}`,
      }
    }
    return {
      class: 'rewrite',
      evidence: `string Jaccard=${overlap.toFixed(3)}; anchors=${anchors}; skel ${fromFn.skeletonHash}→${toFn.skeletonHash}`,
    }
  }
  if (anchors >= 3 && overlap >= 0.3) {
    return {
      class: 'rewrite',
      evidence: `anchors=${anchors}; Jaccard=${overlap.toFixed(3)}; skel ${fromFn.skeletonHash}→${toFn.skeletonHash}`,
    }
  }
  // weak match — treat as no match at this score
  return null
}

function bestMatch(toFn, fromFns, usedFrom) {
  // Exact hash match first
  const exactKey = fnId(toFn)
  for (let i = 0; i < fromFns.length; i++) {
    if (usedFrom.has(i)) continue
    if (fnId(fromFns[i]) === exactKey) return { index: i, result: classifyPair(fromFns[i], toFn) }
  }
  // Same stringHash
  for (let i = 0; i < fromFns.length; i++) {
    if (usedFrom.has(i)) continue
    if (fromFns[i].stringHash === toFn.stringHash) {
      const result = classifyPair(fromFns[i], toFn)
      if (result) return { index: i, result }
    }
  }
  // Same skeletonHash + high string overlap
  let best = null
  for (let i = 0; i < fromFns.length; i++) {
    if (usedFrom.has(i)) continue
    const fromFn = fromFns[i]
    const overlap = jaccard(fromFn.strings || [], toFn.strings || [])
    const anchors = sharedAnchorCount(fromFn.strings || [], toFn.strings || [])
    if (overlap < 0.3 && anchors < 3) continue
    const result = classifyPair(fromFn, toFn)
    if (!result) continue
    const score = overlap * 10 + anchors
    if (!best || score > best.score) best = { index: i, result, score }
  }
  return best
}

function loadChangelogItems(version) {
  if (!existsSync(INV)) return []
  const data = JSON.parse(readFileSync(INV, 'utf8'))
  const block = data.byVersion?.[version]
  return block?.items || []
}

const flags = parseArgs(process.argv.slice(2))
if (!flags.from || !flags.to || !flags.out || !flags.version || !flags.fromVersion) {
  console.error(
    'Usage: node classify.mjs --from <from.fp.json> --to <to.fp.json> --version X --from-version Y --out ledger.json [--src src]',
  )
  process.exit(1)
}

const fromFp = JSON.parse(readFileSync(flags.from, 'utf8'))
const toFp = JSON.parse(readFileSync(flags.to, 'utf8'))
const fromFns = fromFp.functions || []
const toFns = toFp.functions || []

console.log(`Indexing src under ${flags.src} …`)
const stringIndex = buildStringIndex(flags.src)
console.log(`String index keys: ${stringIndex.size}`)

const usedFrom = new Set()
const functions = []
const counts = {
  unchanged: 0,
  'rename-only': 0,
  'small-edit': 0,
  rewrite: 0,
  added: 0,
  removed: 0,
}

for (const toFn of toFns) {
  const id = fnId(toFn)
  const match = bestMatch(toFn, fromFns, usedFrom)
  const srcFile = guessSrcFile(toFn, stringIndex)

  if (!match || !match.result) {
    const row = {
      id,
      class: 'added',
      srcFile,
      evidence: `no prior match; name=${toFn.name || '?'} strings=${(toFn.strings || []).slice(0, 3).join(' | ')}`,
      rewrittenByLlm: false,
      name: toFn.name,
      stringCount: toFn.stringCount,
    }
    functions.push(row)
    counts.added++
    continue
  }

  usedFrom.add(match.index)
  const fromFn = fromFns[match.index]
  const fromId = fnId(fromFn)
  const cls = match.result.class

  if (cls === 'unchanged' && flags.slimUnchanged) {
    functions.push({
      id,
      class: 'unchanged',
      fromId,
      srcFile: srcFile || guessSrcFile(fromFn, stringIndex),
    })
  } else if (cls === 'rename-only') {
    functions.push({
      id,
      class: 'rename-only',
      fromId,
      srcFile: srcFile || guessSrcFile(fromFn, stringIndex),
      evidence: match.result.evidence,
      name: toFn.name,
      fromName: fromFn.name,
    })
  } else {
    functions.push({
      id,
      class: cls,
      fromId,
      srcFile: srcFile || guessSrcFile(fromFn, stringIndex),
      evidence: match.result.evidence,
      rewrittenByLlm: false,
      name: toFn.name,
      stringCount: toFn.stringCount,
    })
  }
  counts[cls]++
}

// Unmatched from → removed
for (let i = 0; i < fromFns.length; i++) {
  if (usedFrom.has(i)) continue
  const fromFn = fromFns[i]
  functions.push({
    id: fnId(fromFn),
    class: 'removed',
    fromId: fnId(fromFn),
    srcFile: guessSrcFile(fromFn, stringIndex),
    evidence: `unmatched in target; name=${fromFn.name || '?'}`,
    name: fromFn.name,
  })
  counts.removed++
}

const changelogItems = loadChangelogItems(flags.version)
const changelogCoverage = changelogItems.map((item) => ({
  item,
  status: 'deferred',
  evidence: 'auto-classified draft — agent must locate or reclassify before hop is done',
}))

const ledger = {
  version: flags.version,
  fromVersion: flags.fromVersion,
  expectedFunctionCount: functions.length,
  generatedAt: new Date().toISOString(),
  counts,
  fromFile: flags.from,
  toFile: flags.to,
  fromFunctionCount: fromFns.length,
  toFunctionCount: toFns.length,
  functions,
  changelogCoverage,
  notes:
    'Draft from classify.mjs. Resolve changelogCoverage (no deferred left). Set rewrittenByLlm on edited rows. Do not LLM-rewrite unchanged.',
}

mkdirSync(dirname(flags.out), { recursive: true })
writeFileSync(flags.out, JSON.stringify(ledger, null, 2) + '\n')
console.log(JSON.stringify({ out: flags.out, expectedFunctionCount: functions.length, counts }, null, 2))
console.log(`Wrote ledger → ${flags.out}`)
