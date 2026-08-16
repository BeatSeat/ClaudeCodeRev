/**
 * Official 2.1.108 `mL6` / `SV` / `qJz`: highlight.js core + on-demand grammars.
 * Startup only registers cedar (extraLanguages). File reads, diffs, and
 * markdown highlighting call ensureLanguage() before highlight().
 */

import type { HLJSApi, LanguageFn } from 'highlight.js'
import { logError } from '../log.js'
import { registerExtraLanguages } from './extraLanguages.js'
import {
  LANGUAGE_ALIASES,
  LANGUAGE_DEPENDENCIES,
  LAZY_LANGUAGE_NAMES,
} from './lazyLanguages.js'

const LANGUAGE_NAME_SET = new Set<string>(LAZY_LANGUAGE_NAMES)

let cachedHljs: HLJSApi | null = null
const registeredLanguages = new Set<string>()
const failedLanguages = new Set<string>()

function unwrapLanguageModule(mod: unknown): LanguageFn {
  if (typeof mod === 'function') return mod as LanguageFn
  if (mod && typeof mod === 'object' && 'default' in mod) {
    const def = (mod as { default: unknown }).default
    if (typeof def === 'function') return def as LanguageFn
  }
  throw new Error('highlight.js language module is not a function')
}

function loadLanguageFactory(name: string): LanguageFn {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(`highlight.js/lib/languages/${name}`)
  return unwrapLanguageModule(mod)
}

/** Official `mL6`. */
export function getHljs(): HLJSApi {
  if (cachedHljs) return cachedHljs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('highlight.js/lib/core')
  const api: HLJSApi =
    'default' in mod && mod.default ? (mod.default as HLJSApi) : (mod as HLJSApi)
  registerExtraLanguages(api)
  cachedHljs = api
  return api
}

/**
 * Official `SV`. Resolve aliases, register the grammar and its dependencies,
 * or return null if the language is unknown / failed to load.
 */
export function ensureLanguage(name: string): string | null {
  const hljs = getHljs()
  const key = name.toLowerCase()
  const canonical = LANGUAGE_NAME_SET.has(key)
    ? key
    : Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, key)
      ? LANGUAGE_ALIASES[key]!
      : null
  if (canonical !== null) {
    if (failedLanguages.has(canonical)) return null
    if (!registeredLanguages.has(canonical)) {
      if (!LANGUAGE_NAME_SET.has(canonical)) return null
      try {
        hljs.registerLanguage(canonical, loadLanguageFactory(canonical))
      } catch (error) {
        failedLanguages.add(canonical)
        logError(error)
        return null
      }
      registeredLanguages.add(canonical)
      for (const dep of LANGUAGE_DEPENDENCIES[canonical] ?? []) {
        ensureLanguage(dep)
      }
    }
    return canonical
  }
  return hljs.getLanguage(key) ? key : null
}
