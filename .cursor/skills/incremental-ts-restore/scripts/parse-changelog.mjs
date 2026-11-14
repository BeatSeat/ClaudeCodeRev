#!/usr/bin/env node
/**
 * Parse official Claude Code CHANGELOG.md into per-version JSON.
 * Usage: node parse-changelog.mjs [changelog.md] [out.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = join(__dir, '..')
const DEFAULT_IN = join(SKILL_ROOT, 'inventory', 'official-CHANGELOG.md')
const DEFAULT_OUT = join(SKILL_ROOT, 'inventory', 'changelog-by-version.json')

const HEADING = /^##\s+(\d+\.\d+\.\d+)\s*$/

export function parseChangelog(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const versions = []
  let current = null

  for (const line of lines) {
    const m = line.match(HEADING)
    if (m) {
      if (current) versions.push(current)
      current = { version: m[1], items: [], raw: '' }
      continue
    }
    if (!current) continue
    current.raw += (current.raw ? '\n' : '') + line
    const item = line.match(/^\s*-\s+(.+)$/)
    if (item) current.items.push(item[1].trim())
  }
  if (current) versions.push(current)

  const byVersion = {}
  for (const v of versions) {
    byVersion[v.version] = {
      version: v.version,
      itemCount: v.items.length,
      items: v.items,
    }
  }
  return { source: 'anthropics/claude-code CHANGELOG.md', parsedAt: new Date().toISOString(), versions, byVersion }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('parse-changelog.mjs')
if (isMain) {
  const input = process.argv[2] || DEFAULT_IN
  const output = process.argv[3] || DEFAULT_OUT
  const md = readFileSync(input, 'utf8')
  const parsed = parseChangelog(md)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(parsed, null, 2) + '\n')
  console.log(`Parsed ${parsed.versions.length} versions → ${output}`)
  const range = parsed.versions.filter((v) => {
    const n = Number(v.version.split('.')[2])
    return v.version.startsWith('2.1.') && n >= 88 && n <= 133
  })
  console.log(`2.1.88–133 changelog headings: ${range.length}`)
}
