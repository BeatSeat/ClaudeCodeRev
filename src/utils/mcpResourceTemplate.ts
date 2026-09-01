/** Official 2.1.98 xj7 / y6A / R85 / L85 / h85 / Ij7 — RFC 6570-lite URI templates. */

export type UriTemplatePart =
  | { type: 'literal'; value: string }
  | { type: 'variable'; name: string }

export type TemplateArgMatch<T extends { uriTemplate: string }> = {
  template: T
  argName: string
  argValue: string
  resolvedArgs: Record<string, string>
  valueStartIndex: number
}

/** Official Ij7: show the template up to the first `{`. */
export function uriTemplateDisplayPrefix(uriTemplate: string): string {
  const brace = uriTemplate.indexOf('{')
  return brace === -1 ? uriTemplate : uriTemplate.slice(0, brace)
}

/** Official xj7. */
export function parseUriTemplate(uriTemplate: string): UriTemplatePart[] {
  const parts: UriTemplatePart[] = []
  let i = 0
  let literalStart = 0
  while (i < uriTemplate.length) {
    if (uriTemplate[i] === '{') {
      if (i > literalStart) {
        parts.push({
          type: 'literal',
          value: uriTemplate.slice(literalStart, i),
        })
      }
      const end = uriTemplate.indexOf('}', i)
      if (end === -1) {
        parts.push({ type: 'literal', value: uriTemplate.slice(i) })
        return parts
      }
      let name = uriTemplate.slice(i + 1, end)
      name = name.replace(/^[+#./;?&]/, '').replace(/\*$|:\d+$/, '')
      const comma = name.indexOf(',')
      if (comma !== -1) name = name.slice(0, comma)
      parts.push({ type: 'variable', name })
      i = end + 1
      literalStart = i
    } else {
      i++
    }
  }
  if (literalStart < uriTemplate.length) {
    parts.push({ type: 'literal', value: uriTemplate.slice(literalStart) })
  }
  return parts
}

/** Official y6A. */
export function matchTypedUriAgainstTemplate<T extends { uriTemplate: string }>(
  template: T,
  typed: string,
): TemplateArgMatch<T> | null {
  const parts = parseUriTemplate(template.uriTemplate)
  const resolvedArgs: Record<string, string> = {}
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === 'literal') {
      const rest = typed.slice(cursor)
      if (rest.length < part.value.length) return null
      if (!rest.startsWith(part.value)) return null
      cursor += part.value.length
      continue
    }
    const next = parts[i + 1]
    const delim = next?.type === 'literal' ? next.value : null
    const rest = typed.slice(cursor)
    if (delim) {
      const at = rest.indexOf(delim)
      if (at === -1) {
        return {
          template,
          argName: part.name,
          argValue: rest,
          resolvedArgs,
          valueStartIndex: cursor,
        }
      }
      resolvedArgs[part.name] = rest.slice(0, at)
      cursor += at
    } else {
      return {
        template,
        argName: part.name,
        argValue: rest,
        resolvedArgs,
        valueStartIndex: cursor,
      }
    }
  }
  return null
}

/** Official R85: most-resolved args, then farthest cursor, then most `{`s. */
export function pickBestTemplateMatch<T extends { uriTemplate: string }>(
  typed: string,
  templates: T[],
): TemplateArgMatch<T> | null {
  let best: TemplateArgMatch<T> | null = null
  let score = [-1, -1, -1]
  for (const template of templates) {
    const match = matchTypedUriAgainstTemplate(template, typed)
    if (!match) continue
    const next = [
      Object.keys(match.resolvedArgs).length,
      match.valueStartIndex,
      (template.uriTemplate.match(/\{/g) ?? []).length,
    ]
    if (
      !best ||
      next[0]! > score[0]! ||
      (next[0] === score[0] && next[1]! > score[1]!) ||
      (next[0] === score[0] && next[1] === score[1] && next[2]! > score[2]!)
    ) {
      best = match
      score = next
    }
  }
  return best
}

/** Official L85: current arg is followed by a literal then another variable. */
export function hasMoreTemplateArgsAfterCurrent(
  match: TemplateArgMatch<{ uriTemplate: string }>,
): boolean {
  const parts = parseUriTemplate(match.template.uriTemplate)
  const resolved = Object.keys(match.resolvedArgs).length
  let seen = 0
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.type !== 'variable') continue
    if (seen === resolved) {
      return (
        parts[i + 1]?.type === 'literal' && parts[i + 2]?.type === 'variable'
      )
    }
    seen++
  }
  return false
}

/** Official h85. */
export function applyTemplateCompletionValue(
  typedAfterServer: string,
  match: TemplateArgMatch<{ uriTemplate: string }>,
  value: string,
): string {
  const prefix = typedAfterServer.slice(0, match.valueStartIndex)
  const parts = parseUriTemplate(match.template.uriTemplate)
  let idx = -1
  let seen = 0
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.type !== 'variable') continue
    if (seen === Object.keys(match.resolvedArgs).length) {
      idx = i
      break
    }
    seen++
  }
  const next = idx >= 0 ? parts[idx + 1] : undefined
  const literal = next?.type === 'literal' ? next.value : ''
  return prefix + value + literal
}
