import chalk from 'chalk'
import { getIsInteractive } from '../../bootstrap/state.js'
import { formatTotalCost, getModelUsage } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { plural } from '../../utils/stringUtils.js'

/** Official 2.1.170 `zt5`. */
function shortModelFamily(name: string): string {
  if (name.includes('fable')) return 'fable'
  if (name.includes('opus')) return 'opus'
  if (name.includes('sonnet')) return 'sonnet'
  if (name.includes('haiku')) return 'haiku'
  return name
}

function formatSubscriptionBreakdown(): string | null {
  const modelUsage = getModelUsage()
  const entries = Object.entries(modelUsage)
  if (entries.length === 0) return null

  const costByFamily: Record<string, number> = {}
  let totalCost = 0
  let inputTokens = 0
  let cacheRead = 0
  let cacheCreate = 0
  for (const [model, usage] of entries) {
    const family = shortModelFamily(getCanonicalName(model))
    costByFamily[family] = (costByFamily[family] ?? 0) + usage.costUSD
    totalCost += usage.costUSD
    inputTokens += usage.inputTokens
    cacheRead += usage.cacheReadInputTokens
    cacheCreate += usage.cacheCreationInputTokens
  }

  const parts: string[] = []
  if (totalCost > 0) {
    for (const [family, cost] of Object.entries(costByFamily).sort(
      (a, b) => b[1] - a[1],
    )) {
      parts.push(`${family}: ${Math.round((cost / totalCost) * 100)}%`)
    }
  }
  const billed = inputTokens + cacheRead + cacheCreate
  if (billed > 0) {
    parts.push(`cache hit: ${Math.round((cacheRead / billed) * 100)}%`)
  }
  return parts.length > 0 ? `breakdown · ${parts.join(' · ')}` : null
}

/** Official 2.1.178 `MF8`. */
const BEHAVIOR_PCT_FLOOR = 10
/** Official 2.1.178 `dD9`. */
const TOP_N = 8

/** Official 2.1.178 `k8z`. */
const BEHAVIOR_LABELS: Record<string, (pct: number) => string> = {
  cache_miss: H => `${H}% of your usage hit a >100k-token cache miss`,
  long_context: H => `${H}% of your usage was at >150k context`,
  subagent_heavy: H =>
    `${H}% of your usage came from subagent-heavy sessions`,
  high_parallel: H =>
    `${H}% of your usage was while 4+ sessions ran in parallel`,
  cron: H => `${H}% of your usage came from sessions active for 8+ hours`,
}

type NamedPct = { name: string; pct: number }
type BehaviorRow = { key: string; pct: number }
type PeriodBehaviors = {
  behaviors: BehaviorRow[]
  skills: NamedPct[]
  agents: NamedPct[]
  plugins: NamedPct[]
  mcp_servers: NamedPct[]
  request_count: number
  session_count: number
}

export type CostUsageSnapshot = {
  behaviors?: { day: PeriodBehaviors; week: PeriodBehaviors }
}

/** Official 2.1.178 `Fd8`. */
function formatTopList(
  title: string,
  items: NamedPct[],
  nameFn?: (name: string) => string,
): string | null {
  if (items.length === 0) return null
  const shown = items
    .slice(0, TOP_N)
    .map(f => `${nameFn ? nameFn(f.name) : f.name} ${f.pct}%`)
    .join(', ')
  const extra = items.length - TOP_N
  return `${title}: ${shown}${extra > 0 ? `, +${extra} more` : ''}`
}

/** Official 2.1.178 `cD9`. */
function formatBehaviorPeriod(
  title: string,
  period: PeriodBehaviors,
): string | null {
  const behaviors = period.behaviors.filter(z => z.pct >= BEHAVIOR_PCT_FLOOR)
  const tops = [
    formatTopList('Top skills', period.skills, z => `/${z}`),
    formatTopList('Top subagents', period.agents),
    formatTopList('Top plugins', period.plugins),
    formatTopList('Top MCP servers', period.mcp_servers),
  ].filter((z): z is string => z !== null)
  if (behaviors.length === 0 && tops.length === 0) return null
  const reqs = `${period.request_count} ${plural(period.request_count, 'request')}`
  const sess = `${period.session_count} ${plural(period.session_count, 'session')}`
  return [
    `${title} · ${reqs} · ${sess}`,
    ...behaviors.map(z => `  ${(BEHAVIOR_LABELS[z.key] ?? (p => `${p}%`))(z.pct)}`),
    ...tops.map(z => `  ${z}`),
  ].join('\n')
}

/** Official 2.1.178 `nD9` / `formatBehaviors`. */
export function formatBehaviors(usage: CostUsageSnapshot): string | null {
  const behaviors = usage.behaviors
  if (!behaviors) return null
  const periods = [
    formatBehaviorPeriod('Last 24h', behaviors.day),
    formatBehaviorPeriod('Last 7d', behaviors.week),
  ].filter((K): K is string => K !== null)
  if (periods.length === 0) return null
  return [
    "What's contributing to your limits usage?",
    'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.',
    '',
    periods.join('\n\n'),
  ].join('\n')
}

/** Official 2.1.178 `I6` — include behaviors only when not interactive. */
function includeBehaviors(): boolean {
  return !getIsInteractive()
}

export const call: LocalCommandCall = async () => {
  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    // Official 2.1.178 `v8z`: `includeBehaviors:I6()` then append `nD9`.
    // Behavior fetch (`tp$`/`OF8`) is Services-owned and not on HEAD — call
    // formatBehaviors with an empty snapshot so the formatter stays live.
    void includeBehaviors()
    const behaviorText = formatBehaviors({})
    if (behaviorText) {
      value += `\n\n${behaviorText}`
    }

    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_lark', false)) {
      const breakdown = formatSubscriptionBreakdown()
      if (breakdown) {
        value += `\n\n${chalk.dim(breakdown)}`
      }
    }
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
