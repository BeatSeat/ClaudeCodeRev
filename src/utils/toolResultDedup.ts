import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { logEvent } from '../services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { sanitizeToolNameForAnalytics } from '../services/analytics/metadata.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../constants/toolLimits.js'

const MIN_DEDUP_CHARS = 256

export type ToolResultDedupState = {
  seen: Map<string, { shortId: string; toolName: string }>
  counter: number
}

export function createToolResultDedupState(): ToolResultDedupState {
  return { seen: new Map(), counter: 0 }
}

/** Official 2.1.92: S8/h8("tengu_onyx_basin_m1k", false). */
export function isToolResultDedupEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_onyx_basin_m1k', false)
}

function hashToolResult(content: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(content).toString(36)
  }
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Official 2.1.92 BVK: identical large tool results collapse to a pointer
 * at the first occurrence's [result-id: rN] footer.
 */
export function applyToolResultDedup(
  block: ToolResultBlockParam,
  toolName: string,
  state: ToolResultDedupState | undefined,
  maxResultSizeChars: number,
): ToolResultBlockParam {
  if (!isToolResultDedupEnabled()) {
    return block
  }
  if (!state) {
    return block
  }
  if (block.is_error) {
    return block
  }
  const content = block.content
  if (typeof content !== 'string') {
    return block
  }
  const originalBytes = content.length
  if (originalBytes <= MIN_DEDUP_CHARS) {
    return block
  }
  const cap = Math.min(maxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
  if (originalBytes >= cap) {
    return block
  }
  const digest = hashToolResult(content)
  const prior = state.seen.get(digest)
  if (prior) {
    const replacement = `<identical to result [${prior.shortId}] from your ${prior.toolName} call earlier — refer to that output>`
    logEvent('tengu_tool_result_dedup', {
      hit: true,
      toolName: sanitizeToolNameForAnalytics(toolName),
      originalBytes,
      savedBytes: originalBytes - replacement.length,
    })
    return { ...block, content: replacement }
  }
  state.counter += 1
  const shortId = `r${state.counter}`
  state.seen.set(digest, { shortId, toolName })
  logEvent('tengu_tool_result_dedup', {
    hit: false,
    toolName: sanitizeToolNameForAnalytics(toolName),
    originalBytes,
    savedBytes: 0,
  })
  return { ...block, content: `${content}\n[result-id: ${shortId}]` }
}

export function isMcpToolForDedup(tool: {
  name?: string
  isMcp?: boolean
}): boolean {
  return tool.name?.startsWith('mcp__') === true || tool.isMcp === true
}
