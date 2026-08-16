import { readFileSync, writeFileSync } from 'node:fs'

const s94 = readFileSync(
  'E:/AiCreatedProjects/ClaudeCodeRev/restore-work/artifacts/official/2.1.94/cli.js',
  'utf8',
)
const s92 = readFileSync(
  'E:/AiCreatedProjects/ClaudeCodeRev/restore-work/artifacts/official/2.1.92/cli.js',
  'utf8',
)

function findFn(src, name) {
  const needle = `function ${name}(`
  const start = src.indexOf(needle)
  if (start < 0) return null
  return { start, code: src.slice(start, start + 500) }
}

const r = { v94: {}, v92: {} }
for (const n of ['Oh', 'Yh', 'ho', 'Ch', 'oo6', 'ao6']) r.v94[n] = findFn(s94, n)
for (const n of ['_C', 'KC', 'yA6', 'jo', 'tL', 'or6', 'rr6'])
  r.v92[n] = findFn(s92, n)

const uses = []
let p = 0
while ((p = s94.indexOf('AnthropicBedrockMantle', p)) !== -1) {
  uses.push({ index: p, snippet: s94.slice(Math.max(0, p - 250), p + 350) })
  p += 10
}
r.AnthropicBedrockMantle_uses = uses

const cq = s94.indexOf(
  'function cq(){return p6(process.env.CLAUDE_CODE_USE_BEDROCK)',
)
r.cq = s94.slice(cq, cq + 800)

const ij = s94.indexOf('function IJ(q){if(q){let K=OW8()')
r.IJ = s94.slice(ij, ij + 1200)

const skip = []
p = 0
while ((p = s94.indexOf('CLAUDE_CODE_SKIP_MANTLE_AUTH', p)) !== -1) {
  skip.push({ index: p, snippet: s94.slice(Math.max(0, p - 350), p + 280) })
  p += 10
}
r.skip_mantle = skip

const key = []
p = 0
while ((p = s94.indexOf('ANTHROPIC_BEDROCK_MANTLE_API_KEY', p)) !== -1) {
  key.push({ index: p, snippet: s94.slice(Math.max(0, p - 300), p + 250) })
  p += 10
}
r.mantle_api_key = key

writeFileSync(
  'E:/AiCreatedProjects/ClaudeCodeRev/restore-work/ledgers/_hop2194-review/ids.json',
  JSON.stringify(r, null, 2),
)
console.log('===94 Oh===')
console.log(r.v94.Oh?.code)
console.log('===94 Yh===')
console.log(r.v94.Yh?.code)
console.log('===94 ho===')
console.log(r.v94.ho?.code)
console.log('===92 _C===')
console.log(r.v92._C?.code)
console.log('===92 KC===')
console.log(r.v92.KC?.code)
console.log('===92 yA6===')
console.log(r.v92.yA6?.code)
console.log('===cq===')
console.log(r.cq)
console.log('===IJ===')
console.log(r.IJ)
console.log('===mantle class uses===', uses.length)
for (const u of uses) console.log('----\n', u.snippet)
console.log('===skip mantle===', skip.length)
for (const u of skip) console.log('----\n', u.snippet)
console.log('===mantle api key===', key.length)
for (const u of key) console.log('----\n', u.snippet)
