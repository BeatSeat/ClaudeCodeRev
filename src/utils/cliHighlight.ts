// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />

import chalk from 'chalk'
import { extname } from 'path'
import { ensureLanguage, getHljs } from './highlighter/lazyHighlight.js'

export type CliHighlight = {
  highlight: (code: string, options?: { language?: string }) => string
  supportsLanguage: (language: string) => boolean
}

// Official 2.1.108 `Nkz` — chalk theme applied to hljs token trees.
const HIGHLIGHT_THEME: Record<string, (text: string) => string> = {
  keyword: chalk.blue,
  built_in: chalk.cyan,
  type: chalk.cyan.dim,
  literal: chalk.blue,
  number: chalk.green,
  regexp: chalk.red,
  string: chalk.red,
  subst: chalk.reset,
  symbol: chalk.reset,
  class: chalk.blue,
  function: chalk.yellow,
  title: chalk.reset,
  params: chalk.reset,
  comment: chalk.green,
  doctag: chalk.green,
  meta: chalk.grey,
  'meta-keyword': chalk.reset,
  'meta-string': chalk.reset,
  section: chalk.reset,
  tag: chalk.grey,
  name: chalk.blue,
  attr: chalk.cyan,
  attribute: chalk.reset,
  variable: chalk.reset,
  bullet: chalk.reset,
  code: chalk.reset,
  emphasis: chalk.italic,
  strong: chalk.bold,
  link: chalk.underline,
  quote: chalk.reset,
  addition: chalk.green,
  deletion: chalk.red,
}

type HljsNode = {
  scope?: string
  kind?: string
  children: (HljsNode | string)[]
}

/** Official `$Q4`. */
function applyHighlightTheme(node: HljsNode | string): string {
  if (typeof node === 'string') return node
  const text = node.children.map(applyHighlightTheme).join('')
  const scope = node.scope ?? node.kind
  const paint = scope
    ? HIGHLIGHT_THEME[scope.replace(/^hljs-/, '')]
    : undefined
  return paint ? paint(text) : text
}

/** Official `Ekz`. */
function highlight(code: string, options?: { language?: string }): string {
  const language = options?.language
  if (!language) return code
  try {
    const resolved = ensureLanguage(language)
    if (!resolved) return code
    const result = getHljs().highlight(code, {
      language: resolved,
      ignoreIllegals: true,
    })
    const emitter =
      (result as { _emitter?: { rootNode?: HljsNode; root?: HljsNode } })
        ._emitter ??
      (result as { emitter?: { rootNode?: HljsNode; root?: HljsNode } })
        .emitter
    const root = emitter?.rootNode ?? emitter?.root
    if (!root || typeof root === 'string') return code
    return root.children.map(applyHighlightTheme).join('')
  } catch {
    return code
  }
}

/** Official `ykz`. */
function supportsLanguage(language: string): boolean {
  return ensureLanguage(language) !== null
}

const cliHighlight: CliHighlight = { highlight, supportsLanguage }

/** Official `m56` / `Lkz`. */
export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  return Promise.resolve(cliHighlight)
}

/**
 * eg. "foo/bar.ts" → "TypeScript". Official `Vx8`.
 */
export async function getLanguageName(file_path: string): Promise<string> {
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  const resolved = ensureLanguage(ext)
  if (!resolved) return 'unknown'
  return getHljs().getLanguage(resolved)?.name ?? 'unknown'
}
