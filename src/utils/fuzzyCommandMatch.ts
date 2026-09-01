/**
 * Official 2.1.108 fg8 / l7Y: closest slash-command name by Levenshtein
 * distance. Length-delta gate is 1 for names ≤3 chars, else 2.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!
      row[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j]!, row[j - 1]!)
      prev = tmp
    }
  }
  return row[b.length]!
}

export function closestCommandName(
  input: string,
  commands: ReadonlyArray<{ name: string; aliases?: string[] }>,
): string | undefined {
  const candidates = commands.flatMap(cmd => [cmd.name, ...(cmd.aliases ?? [])])
  const maxDist = input.length <= 3 ? 1 : 2
  let best: string | undefined
  let bestDist = maxDist + 1
  for (const name of candidates) {
    if (Math.abs(name.length - input.length) > maxDist) continue
    const dist = levenshtein(input, name)
    if (dist < bestDist) {
      bestDist = dist
      best = name
    }
  }
  return best
}
