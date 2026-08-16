import type { HLJSApi, LanguageFn } from 'highlight.js'

const cedarLanguage: LanguageFn = hljs => ({
  name: 'Cedar',
  aliases: ['cedarpolicy'],
  keywords: {
    keyword: 'permit forbid when unless if then else in has like is',
    built_in:
      'principal action resource context decimal ip contains containsAll containsAny',
    literal: 'true false',
  },
  contains: [
    hljs.QUOTE_STRING_MODE,
    hljs.C_NUMBER_MODE,
    hljs.C_LINE_COMMENT_MODE,
    { className: 'meta', begin: /@\w+/ },
    { className: 'type', begin: /\b[A-Z]\w*(::[A-Z]\w*)*/ },
  ],
})

const EXTRA_LANGUAGES: Record<string, LanguageFn> = {
  cedar: cedarLanguage,
}

export function registerExtraLanguages(hljs: HLJSApi): void {
  for (const [name, language] of Object.entries(EXTRA_LANGUAGES)) {
    if (!hljs.getLanguage(name)) {
      hljs.registerLanguage(name, language)
    }
  }
}
