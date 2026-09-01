import chalk from 'chalk'
import { formatTotalCost, getModelUsage } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { getCanonicalName } from '../../utils/model/model.js'

function shortModelFamily(name: string): string {
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
