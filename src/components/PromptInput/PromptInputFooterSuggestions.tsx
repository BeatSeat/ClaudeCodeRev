import * as React from 'react'
import { memo, type ReactNode } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { truncatePathMiddle, truncateToWidth } from '../../utils/format.js'
import { truncateToWidthNoEllipsis } from '../../utils/truncate.js'
import type { Theme } from '../../utils/theme.js'

export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  metadata?: unknown
  color?: keyof Theme
  /** 120 `K.query`: slash filter used for highlight. */
  query?: string
}

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'

export const OVERLAY_MAX_ITEMS = 5

/**
 * 120 `CZ1`. Whole-string match first. `contiguousOnly` skips fuzzy
 * per-character fallback so description highlight stays a contiguous span.
 */
export function matchRanges(
  text: string,
  query: string,
  contiguousOnly = false,
): Array<[number, number]> {
  const lower = text.toLowerCase()
  if (lower.length !== text.length) return []
  const idx = lower.indexOf(query)
  if (idx !== -1) return [[idx, idx + query.length]]
  if (contiguousOnly) return []
  const ranges: Array<[number, number]> = []
  let z = 0
  for (const ch of query) {
    const y = lower.indexOf(ch, z)
    if (y === -1) return []
    const last = ranges.at(-1)
    if (last && last[1] === y) last[1] = y + 1
    else ranges.push([y, y + 1])
    z = y + 1
  }
  return ranges
}

/** 120 `tt8`: matched spans use suggestion color, no bold. */
function HighlightQuery({
  text,
  query,
  color,
  dimColor,
  contiguousOnly = false,
}: {
  text: string
  query?: string
  color?: keyof Theme
  dimColor?: boolean
  contiguousOnly?: boolean
}): ReactNode {
  const ranges = query ? matchRanges(text, query, contiguousOnly) : []
  if (ranges.length === 0) {
    return (
      <Text color={color} dimColor={dimColor}>
        {text}
      </Text>
    )
  }
  const parts: ReactNode[] = []
  const push = (from: number, to: number, hit: boolean) => {
    if (from >= to) return
    parts.push(
      <Text
        key={from}
        color={hit ? 'suggestion' : color}
        dimColor={!hit && dimColor}
      >
        {text.slice(from, to)}
      </Text>,
    )
  }
  let cursor = 0
  for (const [from, to] of ranges) {
    push(cursor, from, false)
    push(from, to, true)
    cursor = to
  }
  push(cursor, text.length, false)
  return <>{parts}</>
}

/** 120 `BZ1`: width wrap on a space boundary. */
function wrapAtWidth(text: string, width: number): [string, string] {
  if (width <= 0 || stringWidth(text) <= width) return [text, '']
  const head = truncateToWidthNoEllipsis(text, width)
  const rest = text.slice(head.length)
  if (rest.startsWith(' ')) return [head, rest.trimStart()]
  const sp = head.lastIndexOf(' ')
  if (sp > 0) return [head.slice(0, sp), text.slice(sp + 1)]
  return [head, rest]
}

/**
 * Get the icon for a suggestion based on its type
 * Icons: + for files, ◇ for MCP resources, * for agents
 */
function getIcon(itemId: string): string {
  if (itemId.startsWith('file-')) return '+'
  if (itemId.startsWith('mcp-resource-') || itemId.startsWith('mcp-template')) {
    return '◇'
  }
  if (itemId.startsWith('agent-')) return '*'
  return '+'
}

/**
 * Check if an item is a unified suggestion type (file, mcp-resource, or agent)
 */
function isUnifiedSuggestion(itemId: string): boolean {
  return (
    itemId.startsWith('file-') ||
    itemId.startsWith('mcp-resource-') ||
    itemId.startsWith('mcp-template') ||
    itemId.startsWith('agent-')
  )
}

/** 120 `pZ1`: 2-line wrap when the flattened description exceeds the slot. */
function rowHeight(
  item: SuggestionItem,
  columns: number,
  maxColumnWidth: number,
  allowWrap: boolean,
): number {
  if (isUnifiedSuggestion(item.id) || !item.description) return 1
  if (!allowWrap) return 1
  const nameWidth = Math.min(maxColumnWidth, Math.floor(columns * 0.4))
  const tagWidth = item.tag ? stringWidth(`[${item.tag}] `) : 0
  const descWidth = Math.max(0, columns - nameWidth - tagWidth - 4)
  if (descWidth <= 0) return 1
  const flat = item.description.replace(/\s+/g, ' ').trim()
  return stringWidth(flat) > descWidth ? 2 : 1
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
  allowWrap = true,
}: {
  item: SuggestionItem
  maxColumnWidth?: number
  isSelected: boolean
  allowWrap?: boolean
}): ReactNode {
  const columns = useTerminalSize().columns
  const isUnified = isUnifiedSuggestion(item.id)

  // For unified suggestions (file, mcp-resource, agent), use single-line layout with icon
  if (isUnified) {
    const icon = getIcon(item.id)
    const textColor: keyof Theme | undefined = isSelected
      ? 'suggestion'
      : undefined
    const dimColor = !isSelected

    const isFile =
      item.id.startsWith('file-') || item.id.startsWith('mcp-template::')
    const isMcpResource = item.id.startsWith('mcp-resource-')
    const isMcpTemplateValue = item.id.startsWith('mcp-template-value::')

    // Calculate layout widths
    // Layout: "X " (2) + displayText + " – " (3) + description + padding (4)
    const iconWidth = 2 // icon + space (fixed)
    const paddingWidth = 4
    const separatorWidth = item.description ? 3 : 0 // ' – ' separator

    // For files, truncate middle of path to show both directory context and filename
    // For MCP resources, limit displayText to 30 chars (truncate from end)
    // For agents, no truncation
    let displayText: string
    if (isFile || isMcpTemplateValue) {
      // Reserve space for description if present, otherwise use all available space
      const descReserve = item.description
        ? Math.min(20, stringWidth(item.description))
        : 0
      const maxPathLength =
        columns - iconWidth - paddingWidth - separatorWidth - descReserve
      displayText = isMcpTemplateValue
        ? truncateToWidth(item.displayText, maxPathLength)
        : truncatePathMiddle(item.displayText, maxPathLength)
    } else if (isMcpResource) {
      const maxDisplayTextLength = 30
      displayText = truncateToWidth(item.displayText, maxDisplayTextLength)
    } else {
      displayText = item.displayText
    }

    const availableWidth =
      columns -
      iconWidth -
      stringWidth(displayText) -
      separatorWidth -
      paddingWidth

    // Build the full line as a single string to prevent wrapping
    let lineContent: string
    if (item.description) {
      const maxDescLength = Math.max(0, availableWidth)
      const truncatedDesc = truncateToWidth(
        item.description.replace(/\s+/g, ' '),
        maxDescLength,
      )
      lineContent = `${icon} ${displayText} – ${truncatedDesc}`
    } else {
      lineContent = `${icon} ${displayText}`
    }

    return (
      <Text color={textColor} dimColor={dimColor} wrap="truncate">
        {lineContent}
      </Text>
    )
  }

  // For non-unified suggestions (commands, shell, etc.), 120 wrap + highlight.
  const maxNameWidth = Math.floor(columns * 0.4)
  const displayTextWidth = Math.min(
    maxColumnWidth ?? stringWidth(item.displayText) + 5,
    maxNameWidth,
  )

  const textColor = item.color || (isSelected ? 'suggestion' : undefined)
  const shouldDim = !isSelected

  let displayText = item.displayText
  if (stringWidth(displayText) > displayTextWidth - 2) {
    displayText = truncateToWidth(displayText, displayTextWidth - 2)
  }
  const padWidth = Math.max(0, displayTextWidth - stringWidth(displayText))
  const paddedSpaces = ' '.repeat(padWidth)

  const tagText = item.tag ? `[${item.tag}] ` : ''
  const tagWidth = stringWidth(tagText)
  const descriptionWidth = Math.max(
    0,
    columns - displayTextWidth - tagWidth - 4,
  )
  const flatDescription = item.description
    ? item.description.replace(/\s+/g, ' ').trim()
    : ''
  const [descHead, descRest] = allowWrap
    ? wrapAtWidth(flatDescription, descriptionWidth)
    : [truncateToWidth(flatDescription, descriptionWidth), '']
  const descColor: keyof Theme | undefined = isSelected
    ? 'suggestion'
    : undefined

  const firstLine = (
    <Text wrap="truncate">
      <HighlightQuery
        text={displayText}
        query={item.query}
        color={textColor}
        dimColor={shouldDim}
      />
      <Text color={textColor} dimColor={shouldDim}>
        {paddedSpaces}
      </Text>
      {tagText ? <Text dimColor>{tagText}</Text> : null}
      <HighlightQuery
        text={descHead}
        query={item.query}
        color={descColor}
        dimColor={!isSelected}
        contiguousOnly
      />
    </Text>
  )

  if (!descRest) return firstLine

  const indentWidth = displayTextWidth + tagWidth
  const second = truncateToWidth(
    descRest,
    Math.max(0, columns - indentWidth - 4),
  )
  return (
    <Box flexDirection="column">
      {firstLine}
      <Text wrap="truncate">
        {' '.repeat(indentWidth)}
        <HighlightQuery
          text={second}
          query={item.query}
          color={descColor}
          dimColor={!isSelected}
          contiguousOnly
        />
      </Text>
    </Box>
  )
})

type Props = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  /** Official 2.1.116: shown when a slash filter has zero matches. */
  emptyMessage?: string
  /**
   * When true, the suggestions are rendered inside a position=absolute
   * overlay. We omit minHeight and flex-end so the y-clamp in the
   * renderer doesn't push fewer items down into the prompt area.
   */
  overlay?: boolean
  /** Official 2.1.116 etH noPad: skip spacer rows (fullscreen overlay). */
  noPad?: boolean
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  emptyMessage,
  overlay,
  noPad,
}: Props): ReactNode {
  const { rows, columns } = useTerminalSize()
  // Maximum number of suggestions to show at once (leaving space for prompt).
  // Overlay mode (fullscreen) uses a fixed 5 — the floating box sits over
  // the ScrollBox, so terminal height isn't the constraint.
  const maxVisibleItems = overlay
    ? OVERLAY_MAX_ITEMS
    : Math.min(6, Math.max(1, rows - 3))

  // Official 2.1.116: keep the menu chrome when the filter has zero hits.
  if (suggestions.length === 0) {
    if (!emptyMessage) return null
    const pad = noPad ? 0 : Math.max(0, maxVisibleItems - 1)
    return (
      <Box
        flexDirection="column"
        justifyContent={overlay ? undefined : 'flex-end'}
      >
        <Text dimColor wrap="truncate">
          {emptyMessage}
        </Text>
        {Array.from({ length: pad }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}
      </Box>
    )
  }

  // Use prop if provided (stable width from all commands), otherwise calculate from visible
  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 5

  const allowWrap = maxVisibleItems >= 2
  const heights = suggestions.map(item =>
    rowHeight(item, columns, maxColumnWidth, allowWrap),
  )

  // 120 line-height window: keep the focused row on screen, fill remaining
  // rows around it. Prevents the jump when wrap height changes while typing.
  const focused = Math.max(
    0,
    Math.min(selectedSuggestion, suggestions.length - 1),
  )
  let startIndex = focused
  let endIndex = focused + 1
  let usedHeight = heights[focused] ?? 1
  let above = 0
  const half = Math.floor(maxVisibleItems / 2)
  while (
    startIndex > 0 &&
    usedHeight < maxVisibleItems &&
    above + (heights[startIndex - 1] ?? 1) <= half
  ) {
    startIndex--
    above += heights[startIndex] ?? 1
  }
  usedHeight += above
  while (
    endIndex < suggestions.length &&
    usedHeight + (heights[endIndex] ?? 1) <= maxVisibleItems
  ) {
    usedHeight += heights[endIndex] ?? 1
    endIndex++
  }
  while (
    startIndex > 0 &&
    usedHeight + (heights[startIndex - 1] ?? 1) <= maxVisibleItems
  ) {
    startIndex--
    usedHeight += heights[startIndex] ?? 1
  }

  const visibleItems = suggestions.slice(startIndex, endIndex)
  // 120: `noPad` always 0. 119 also gated on showing-all (`P===0&&Z===q.length`).
  const pad = noPad ? 0 : Math.max(0, maxVisibleItems - usedHeight)

  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : 'flex-end'}
    >
      {visibleItems.map(item => (
        <SuggestionItemRow
          key={item.id}
          item={item}
          maxColumnWidth={maxColumnWidth}
          isSelected={item.id === suggestions[selectedSuggestion]?.id}
          allowWrap={allowWrap}
        />
      ))}
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
