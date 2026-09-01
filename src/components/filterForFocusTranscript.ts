import { feature } from 'bun:bundle'
import { findToolByName, type Tools } from '../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import type {
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  GroupedToolUseMessage,
  Message,
} from '../types/message.js'
import { uniq } from '../utils/array.js'

const SNIP_TOOL_NAME = feature('HISTORY_SNIP') ? 'Snip' : null

const EDIT_TOOL_NAMES = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
])

export type FocusToolStats = {
  readCount: number
  searchCount: number
  bashCount?: number
  editFileCount?: number
  linesAdded?: number
  linesRemoved?: number
  otherToolCount?: number
}

type ToolUseResultWithStats = {
  toolStats?: FocusToolStats
  status?: string
  agentId?: string
}

function countLines(value: unknown): number {
  return typeof value === 'string' && value.length > 0
    ? value.split('\n').length
    : 0
}

function editLineDelta(
  toolName: string,
  input: unknown,
): { added: number; removed: number } {
  if (typeof input !== 'object' || input === null) {
    return { added: 0, removed: 0 }
  }
  const fields = input as {
    new_string?: unknown
    old_string?: unknown
    content?: unknown
    new_source?: unknown
  }
  if (toolName === FILE_EDIT_TOOL_NAME) {
    return {
      added: countLines(fields.new_string),
      removed: countLines(fields.old_string),
    }
  }
  if (toolName === FILE_WRITE_TOOL_NAME) {
    return { added: countLines(fields.content), removed: 0 }
  }
  if (toolName === NOTEBOOK_EDIT_TOOL_NAME) {
    return { added: countLines(fields.new_source), removed: 0 }
  }
  return { added: 0, removed: 0 }
}

function getOriginKind(origin: unknown): string | undefined {
  if (origin && typeof origin === 'object' && 'kind' in origin) {
    const kind = (origin as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind : undefined
  }
  return undefined
}

function firstContentBlock(
  content: unknown,
): { type?: string; name?: string; input?: unknown; text?: string } | undefined {
  if (!Array.isArray(content)) return undefined
  const first = content[0]
  if (!first || typeof first !== 'object') return undefined
  return first as {
    type?: string
    name?: string
    input?: unknown
    text?: string
  }
}

/** Official Ld4: human-authored user prompt (not a tool_result). */
function isHumanUserPrompt(msg: CollapsibleMessage): boolean {
  if (msg.type !== 'user') return false
  if (firstContentBlock(msg.message.content)?.type === 'tool_result') {
    return false
  }
  const kind = getOriginKind(msg.origin)
  return kind === undefined || kind === 'human'
}

/** Official Rd4: assistant message whose first block is non-empty text. */
function isAssistantTextMessage(msg: CollapsibleMessage): boolean {
  if (msg.type !== 'assistant') return false
  const block = firstContentBlock(msg.message.content)
  return (
    block?.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.trim().length > 0
  )
}

function isAbsorbedToolName(toolName: string): boolean {
  return (
    toolName === TOOL_SEARCH_TOOL_NAME ||
    (SNIP_TOOL_NAME !== null && toolName === SNIP_TOOL_NAME)
  )
}

function emptyCollapsedGroup(
  msg: CollapsibleMessage,
): CollapsedReadSearchGroup {
  return {
    type: 'collapsed_read_search',
    searchCount: 0,
    readCount: 0,
    listCount: 0,
    replCount: 0,
    memorySearchCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
    messages: [msg as Message],
    displayMessage: msg,
    uuid: msg.uuid,
    timestamp: 'timestamp' in msg ? msg.timestamp : undefined,
  }
}

/** Official hd4: fold one tool-use (or grouped tool-use) into a collapsed group. */
function collapseToolUse(
  msg: CollapsibleMessage,
  toolName: string,
  inputs: unknown[],
  tools: Tools,
): CollapsedReadSearchGroup {
  const tool = findToolByName(tools, toolName)
  const count = inputs.length
  const group = emptyCollapsedGroup(msg)
  if (isAbsorbedToolName(toolName)) {
    return group
  }
  if (tool?.isMcp) {
    group.mcpCallCount = count
    if (tool.mcpInfo?.serverName) {
      group.mcpServerNames = [tool.mcpInfo.serverName]
    }
    return group
  }
  if (EDIT_TOOL_NAMES.has(toolName)) {
    group.editFileCount = count
    let added = 0
    let removed = 0
    for (const input of inputs) {
      const delta = editLineDelta(toolName, input)
      added += delta.added
      removed += delta.removed
    }
    if (added > 0) group.linesAdded = added
    if (removed > 0) group.linesRemoved = removed
    return group
  }
  group.otherToolCount = count
  return group
}

/** Official YEz: merge source counts/messages into dest. */
function mergeCollapsedGroups(
  dest: CollapsedReadSearchGroup,
  source: CollapsedReadSearchGroup,
): void {
  dest.searchCount += source.searchCount
  dest.readCount += source.readCount
  dest.listCount += source.listCount
  dest.replCount = (dest.replCount ?? 0) + (source.replCount ?? 0)
  dest.memorySearchCount =
    (dest.memorySearchCount ?? 0) + (source.memorySearchCount ?? 0)
  dest.memoryReadCount =
    (dest.memoryReadCount ?? 0) + (source.memoryReadCount ?? 0)
  dest.memoryWriteCount =
    (dest.memoryWriteCount ?? 0) + (source.memoryWriteCount ?? 0)
  if (source.mcpCallCount) {
    dest.mcpCallCount = (dest.mcpCallCount ?? 0) + source.mcpCallCount
    dest.mcpServerNames = uniq([
      ...(dest.mcpServerNames ?? []),
      ...(source.mcpServerNames ?? []),
    ])
  }
  if (source.bashCount) {
    dest.bashCount = (dest.bashCount ?? 0) + source.bashCount
  }
  if (source.gitOpBashCount) {
    dest.gitOpBashCount = (dest.gitOpBashCount ?? 0) + source.gitOpBashCount
  }
  if (source.otherToolCount) {
    dest.otherToolCount = (dest.otherToolCount ?? 0) + source.otherToolCount
  }
  if (source.editFileCount) {
    dest.editFileCount = (dest.editFileCount ?? 0) + source.editFileCount
  }
  if (source.linesAdded) {
    dest.linesAdded = (dest.linesAdded ?? 0) + source.linesAdded
  }
  if (source.linesRemoved) {
    dest.linesRemoved = (dest.linesRemoved ?? 0) + source.linesRemoved
  }
  if (source.commits?.length) {
    dest.commits = [...(dest.commits ?? []), ...source.commits]
  }
  if (source.pushes?.length) {
    dest.pushes = [...(dest.pushes ?? []), ...source.pushes]
  }
  if (source.branches?.length) {
    dest.branches = [...(dest.branches ?? []), ...source.branches]
  }
  if (source.prs?.length) {
    dest.prs = [...(dest.prs ?? []), ...source.prs]
  }
  if (source.readFilePaths?.length) {
    dest.readFilePaths = [
      ...(dest.readFilePaths ?? []),
      ...source.readFilePaths,
    ]
  }
  if (source.searchArgs?.length) {
    dest.searchArgs = [...(dest.searchArgs ?? []), ...source.searchArgs]
  }
  if (source.hookCount) {
    dest.hookCount = (dest.hookCount ?? 0) + source.hookCount
    dest.hookTotalMs = (dest.hookTotalMs ?? 0) + (source.hookTotalMs ?? 0)
    dest.hookInfos = [...(dest.hookInfos ?? []), ...(source.hookInfos ?? [])]
  }
  dest.latestDisplayHint = source.latestDisplayHint ?? dest.latestDisplayHint
  dest.messages.push(...source.messages)
}

function asToolUseResult(value: unknown): ToolUseResultWithStats | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as ToolUseResultWithStats
}

function groupedToolInputs(msg: GroupedToolUseMessage): unknown[] {
  return msg.messages.map(inner => {
    if (inner.type !== 'assistant' && inner.type !== 'user') return undefined
    return firstContentBlock(inner.message.content)?.input
  })
}

/**
 * Official bd4: in NO_FLICKER Focus mode, split by human prompts and collapse
 * each completed turn's tool uses into one summary line, keeping the last
 * assistant text. The in-progress turn keeps streaming assistant text as
 * pendingText on the group.
 */
export function filterForFocusTranscript(
  messages: CollapsibleMessage[],
  tools: Tools,
  lookupAgentToolStats: (agentId: string) => FocusToolStats | undefined,
  isLoading = false,
): CollapsibleMessage[] {
  const out: CollapsibleMessage[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    if (!isHumanUserPrompt(msg)) {
      out.push(msg)
      i++
      continue
    }
    out.push(msg)
    i++
    let turnEnd = i
    while (turnEnd < messages.length && !isHumanUserPrompt(messages[turnEnd]!)) {
      turnEnd++
    }
    const isCurrentTurn = isLoading && turnEnd === messages.length
    let lastAssistantTextIdx = -1
    if (!isCurrentTurn) {
      for (let j = turnEnd - 1; j >= i; j--) {
        if (isAssistantTextMessage(messages[j]!)) {
          lastAssistantTextIdx = j
          break
        }
      }
    }
    const foldEnd = lastAssistantTextIdx === -1 ? turnEnd : lastAssistantTextIdx
    let group: CollapsedReadSearchGroup | null = null
    let pendingText: string | undefined
    for (let j = i; j < foldEnd; j++) {
      const item = messages[j]!
      let folded: CollapsedReadSearchGroup | null = null
      if (item.type === 'collapsed_read_search') {
        folded = item
      } else if (item.type === 'grouped_tool_use') {
        folded = collapseToolUse(
          item,
          item.toolName,
          groupedToolInputs(item),
          tools,
        )
      } else if (item.type === 'assistant') {
        const block = firstContentBlock(item.message.content)
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          folded = collapseToolUse(item, block.name, [block.input], tools)
        } else if (
          isCurrentTurn &&
          block?.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim().length > 0
        ) {
          pendingText = block.text
        }
      } else if (item.type === 'user' && group) {
        group.messages.push(item)
        const result = asToolUseResult(item.toolUseResult)
        const stats =
          result?.toolStats ??
          (result?.status === 'async_launched' && result.agentId
            ? lookupAgentToolStats(result.agentId)
            : undefined)
        if (stats) {
          group.readCount += stats.readCount
          group.searchCount += stats.searchCount
          if (stats.bashCount) {
            group.bashCount = (group.bashCount ?? 0) + stats.bashCount
          }
          if (stats.editFileCount) {
            group.editFileCount = (group.editFileCount ?? 0) + stats.editFileCount
          }
          if (stats.linesAdded) {
            group.linesAdded = (group.linesAdded ?? 0) + stats.linesAdded
          }
          if (stats.linesRemoved) {
            group.linesRemoved = (group.linesRemoved ?? 0) + stats.linesRemoved
          }
          if (stats.otherToolCount) {
            group.otherToolCount =
              (group.otherToolCount ?? 0) + stats.otherToolCount
          }
        }
      }
      if (folded) {
        if (group) {
          mergeCollapsedGroups(group, folded)
        } else {
          group = { ...folded, messages: [...folded.messages] }
        }
      }
    }
    if (group) {
      group.uuid = `brief-${group.uuid}`
      if (pendingText) group.pendingText = pendingText
      out.push(group)
    }
    if (lastAssistantTextIdx !== -1) {
      out.push(messages[lastAssistantTextIdx]!)
    }
    i = turnEnd
  }
  return out
}
