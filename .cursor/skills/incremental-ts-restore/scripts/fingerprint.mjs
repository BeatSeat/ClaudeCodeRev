#!/usr/bin/env node
/**
 * Extract minify-invariant fingerprints from a JS file (usually cli.js).
 * Skeleton: function-level string sets + α-normalized skeleton hash.
 *
 *   node fingerprint.mjs <file.js> [--out fingerprints.json]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as acorn from 'acorn'

function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return
  if (node.type) fn(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) walk(item, fn, node)
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, fn, node)
    }
  }
}

function isFn(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
}

function collectStrings(fnNode) {
  const strings = []
  walk(fnNode, (n) => {
    if (n === fnNode) return
    if (isFn(n)) return
    if (n.type === 'Literal' && typeof n.value === 'string' && n.value.length >= 2) {
      strings.push(n.value)
    } else if (n.type === 'TemplateElement' && n.value?.cooked) {
      strings.push(n.value.cooked)
    }
  })
  return [...new Set(strings)].sort()
}

function skeleton(fnNode) {
  const parts = []
  walk(fnNode, (n) => {
    if (n.type === 'Identifier') parts.push('ID')
    else if (n.type === 'Literal') parts.push(typeof n.value === 'string' ? 'STR' : 'LIT')
    else parts.push(n.type)
  })
  return createHash('sha256').update(parts.join(',')).digest('hex').slice(0, 16)
}

function extractFunctions(ast) {
  const fns = []
  walk(ast, (n, parent) => {
    if (!isFn(n)) return
    if (parent && isFn(parent)) return
    const name =
      n.id?.name ||
      (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier' ? parent.id.name : null) ||
      (parent?.type === 'Property' && parent.key?.type === 'Identifier' ? parent.key.name : null) ||
      null
    const strings = collectStrings(n)
    fns.push({
      name,
      start: n.start,
      end: n.end,
      params: n.params?.length ?? 0,
      stringCount: strings.length,
      strings: strings.slice(0, 40),
      stringHash: createHash('sha256').update(strings.join('\0')).digest('hex').slice(0, 16),
      skeletonHash: skeleton(n),
    })
  })
  return fns
}

const file = process.argv[2]
if (!file) {
  console.error('Usage: node fingerprint.mjs <file.js> [--out out.json]')
  process.exit(1)
}
const outIdx = process.argv.indexOf('--out')
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null

const code = readFileSync(file, 'utf8')
let ast
try {
  ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
} catch {
  ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true })
}

const functions = extractFunctions(ast)
const report = {
  file,
  bytes: code.length,
  functionCount: functions.length,
  generatedAt: new Date().toISOString(),
  functions,
}

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`Wrote ${functions.length} fingerprints → ${outPath}`)
} else {
  console.log(JSON.stringify({ file, bytes: code.length, functionCount: functions.length }, null, 2))
}
