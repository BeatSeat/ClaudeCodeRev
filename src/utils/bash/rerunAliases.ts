import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

export type BashRerunAliases = {
  map: Map<string, string>
  nextId: number
}

export function createBashRerunAliases(): BashRerunAliases {
  return { map: new Map(), nextId: 1 }
}

/** Official 2.1.92: S8/h8("tengu_velvet_anchor", false). */
export function isBashRerunEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_velvet_anchor', false)
}

export function allocateBashRerunAlias(
  aliases: BashRerunAliases,
  command: string,
): string {
  const id = `b${aliases.nextId++}`
  aliases.map.set(id, command)
  return id
}

export function resolveBashRerunAlias(
  aliases: BashRerunAliases | undefined,
  rerun: string,
): { command: string } | { error: string } {
  const command = aliases?.map.get(rerun)
  if (command !== undefined) {
    return { command }
  }
  const keys = aliases ? Array.from(aliases.map.keys()) : []
  const valid = keys.length > 0 ? keys.join(', ') : 'none'
  return {
    error: `Unknown rerun alias '${rerun}'. Valid aliases this session: ${valid}. Provide {command: "..."} instead.`,
  }
}

export function formatBashRerunFooter(alias: string): string {
  return `[rerun: ${alias}]`
}
