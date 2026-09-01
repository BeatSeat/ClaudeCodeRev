import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterOverlay } from '../context/overlayContext.js'
import {
  getTimestampedHistory,
  HISTORY_PICKER_SCOPES,
  type HistoryPickerScope,
  type TimestampedHistoryEntry,
} from '../history.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { HistoryEntry } from '../utils/config.js'
import { formatRelativeTimeAgo, truncateToWidth } from '../utils/format.js'
import { FuzzyPicker } from './design-system/FuzzyPicker.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type Props = {
  initialQuery?: string
  onSelect: (entry: HistoryEntry) => void
  onCancel: () => void
}

const PREVIEW_ROWS = 6
const AGE_WIDTH = 8

type Item = {
  entry: TimestampedHistoryEntry
  display: string
  lower: string
  firstLine: string
  age: string
}

export function HistorySearchDialog({
  initialQuery,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  useRegisterOverlay('history-search')
  const { columns } = useTerminalSize()

  // Official 2.1.129 `mT4`: default all prompts across all projects
  // (pre-2.1.124). Ctrl+S cycles session → project → everywhere.
  const [scope, setScope] = useState<HistoryPickerScope>('everywhere')
  const [items, setItems] = useState<Item[] | null>(null)
  const [query, setQuery] = useState(initialQuery ?? '')
  const cacheRef = useRef<Partial<Record<HistoryPickerScope, Item[]>>>({})

  useEffect(() => {
    const cached = cacheRef.current[scope]
    if (cached) {
      setItems(cached)
      return
    }
    setItems(null)
    let cancelled = false
    void (async () => {
      const reader = getTimestampedHistory(scope)
      const loaded: Item[] = []
      for await (const entry of reader) {
        if (cancelled) {
          void reader.return(undefined)
          return
        }
        const display = entry.display
        const nl = display.indexOf('\n')
        const age = formatRelativeTimeAgo(new Date(entry.timestamp))
        loaded.push({
          entry,
          display,
          lower: display.toLowerCase(),
          firstLine: nl === -1 ? display : display.slice(0, nl),
          age: age + ' '.repeat(Math.max(0, AGE_WIDTH - stringWidth(age))),
        })
      }
      if (!cancelled) {
        cacheRef.current[scope] = loaded
        setItems(loaded)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope])

  const scopeChord = useShortcutDisplay(
    'historySearch:cycleScope',
    'HistorySearch',
    'ctrl+s',
  )
  useKeybinding(
    'historySearch:cycleScope',
    () => {
      const idx = HISTORY_PICKER_SCOPES.indexOf(scope)
      const next =
        HISTORY_PICKER_SCOPES[(idx + 1) % HISTORY_PICKER_SCOPES.length]!
      setScope(next)
      logEvent('tengu_history_picker_scope', {
        from: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        to: next as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    },
    { context: 'HistorySearch' },
  )

  const filtered = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    if (!q) return items
    const exact: Item[] = []
    const fuzzy: Item[] = []
    for (const item of items) {
      if (item.lower.includes(q)) {
        exact.push(item)
      } else if (isSubsequence(item.lower, q)) {
        fuzzy.push(item)
      }
    }
    return exact.concat(fuzzy)
  }, [items, query])

  const previewOnRight = columns >= 100
  const listWidth = previewOnRight
    ? Math.floor((columns - 6) * 0.5)
    : columns - 6
  const rowWidth = Math.max(20, listWidth - AGE_WIDTH - 1)
  const previewWidth = previewOnRight
    ? Math.max(20, columns - listWidth - 12)
    : Math.max(20, columns - 10)

  return (
    <FuzzyPicker
      title={
        <Text>
          Search prompts <Text color="suggestion">· {scope}</Text>
        </Text>
      }
      placeholder="Filter history…"
      initialQuery={initialQuery}
      resetKey={scope}
      items={filtered}
      getKey={item => String(item.entry.timestamp)}
      onQueryChange={setQuery}
      onSelect={item => {
        logEvent('tengu_history_picker_select', {
          result_count: filtered.length,
          query_length: query.length,
        })
        void item.entry.resolve().then(onSelect)
      }}
      onCancel={onCancel}
      extraHints={<KeyboardShortcutHint chord={scopeChord} action="scope" />}
      emptyMessage={q =>
        items === null
          ? 'Loading…'
          : q
            ? 'No matching prompts'
            : 'No history yet'
      }
      selectAction="use"
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      renderItem={(item, isFocused) => (
        <Text>
          <Text dimColor>{item.age}</Text>
          <Text color={isFocused ? 'suggestion' : undefined}>
            {' '}
            {truncateToWidth(item.firstLine, rowWidth)}
          </Text>
        </Text>
      )}
      renderPreview={item => {
        const wrapped = wrapAnsi(item.display, previewWidth, { hard: true })
          .split('\n')
          .filter(l => l.trim() !== '')
        const overflow = wrapped.length > PREVIEW_ROWS
        const shown = wrapped.slice(
          0,
          overflow ? PREVIEW_ROWS - 1 : PREVIEW_ROWS,
        )
        const more = wrapped.length - shown.length
        return (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderDimColor
            paddingX={1}
            height={PREVIEW_ROWS + 2}
          >
            {shown.map((row, i) => (
              <Text key={i} dimColor>
                {row}
              </Text>
            ))}
            {more > 0 && <Text dimColor>{`… +${more} more lines`}</Text>}
          </Box>
        )
      }}
    />
  )
}

function isSubsequence(text: string, query: string): boolean {
  let j = 0
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] === query[j]) j++
  }
  return j === query.length
}
