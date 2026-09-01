import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import type { Message } from '../types/message.js'
import { getGlobalConfig } from './config.js'

export type ResumeReturnOffer = {
  sessionAgeMinutes: number
  estimatedTokens: number
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

/**
 * Official 2.1.117 $s7: offer summarize-on-resume for stale large sessions.
 * Shared by --resume and slash /resume (both land in REPL with messages).
 */
export function getResumeReturnOffer(
  messages: readonly Message[],
  tokenCount: (messages: readonly Message[]) => number,
): ResumeReturnOffer | null {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_gleaming_fair', false)) {
    return null
  }
  if (getGlobalConfig().resumeReturnDismissed) {
    return null
  }
  const ageThresholdMinutes = parseEnvInt(
    process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
    70,
  )
  const tokenThreshold = parseEnvInt(
    process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
    1e5,
  )
  const recentCutoff = Date.now() - 60_000
  const lastStaleTimestamp = messages.findLast(
    message =>
      (message.type === 'user' || message.type === 'assistant') &&
      Date.parse(message.timestamp) < recentCutoff,
  )?.timestamp
  if (!lastStaleTimestamp) {
    return null
  }
  const sessionAgeMinutes =
    (Date.now() - Date.parse(lastStaleTimestamp)) / 60_000
  if (sessionAgeMinutes < ageThresholdMinutes) {
    return null
  }
  const estimatedTokens = tokenCount(messages)
  if (estimatedTokens < tokenThreshold) {
    return null
  }
  return { sessionAgeMinutes, estimatedTokens }
}
