/**
 * MemoryWriteSurvey — the confirmation dialog shown after a memory file
 * write (official 2.1.120 bundle component `BZ4`/`TG5`).
 *
 * Renders a "Memory updated/written" header, the recorded content (a diff for
 * edits, the body text for new files, or the one-sentence LLM summary when
 * truncated), a "… +N lines" indicator for hidden content, and the
 * "1: Keep / 2: Undo" options. Digit "1"/"2" typed into the prompt (debounced)
 * or the option rows drive the outcome.
 */
import * as React from 'react'
import type { StructuredPatchHunk } from 'diff'
import { basename } from 'path'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { StructuredDiffList } from '../StructuredDiffList.js'
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js'
import type { MemoryWriteRecord } from './memoryWriteSurvey.js'

type Outcome = 'approve' | 'reject'

// Bundle `uZ4`: option key → outcome.
const OPTION_KEY_TO_OUTCOME: Record<string, Outcome> = {
  '1': 'approve',
  '2': 'reject',
}
// Bundle `WG5`: the two options (label text is the user-facing copy).
const OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '1', label: 'Keep' },
  { key: '2', label: 'Undo' },
]
const OPTION_WIDTH = 10

type Props = {
  record: MemoryWriteRecord
  summary: string | null
  lineCount: number
  summaryLineThreshold: number
  countdownSec: number | null
  onOutcome: (outcome: Outcome) => void
  inputValue: string
  setInputValue: (value: string) => void
}

export function MemoryWriteSurvey({
  record,
  summary,
  lineCount,
  summaryLineThreshold,
  countdownSec,
  onOutcome,
  inputValue,
  setInputValue,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()

  // Only a bare "1" or "2" is a shortcut; any other typed text dismisses the
  // digit listener (mirrors the other surveys' input gating).
  const isValidDigit = (char: string): char is '1' | '2' =>
    char === '1' || char === '2'
  useDebouncedDigitInput({
    inputValue,
    setInputValue,
    isValidDigit,
    onDigit: digit => onOutcome(OPTION_KEY_TO_OUTCOME[digit] ?? 'approve'),
  })

  const truncated = lineCount > summaryLineThreshold
  const hiddenCount = Math.max(0, lineCount - summaryLineThreshold)
  const bodyWidth = Math.max(20, columns - 6)
  const fileName = basename(record.filePath)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box minWidth={2}>
          <Text color="ansi:cyan">●</Text>
        </Box>
        <Text bold>{`Memory ${record.isEdit ? 'updated' : 'written'}`}</Text>
        {countdownSec !== null && (
          <Text dimColor>{` · auto-hides in ${countdownSec}s`}</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Box>
          <Box minWidth={2}>
            <Text dimColor>┬</Text>
          </Box>
          <Text dimColor>
            {fileName}
            {'─'.repeat(Math.max(0, columns - 2 - stringWidth(fileName) - 1))}
          </Text>
        </Box>
        <Box paddingX={1} flexDirection="column">
          <MemoryWriteSurveyBody
            record={record}
            summary={summary}
            truncated={truncated}
            maxLines={summaryLineThreshold}
            width={bodyWidth}
            hiddenCount={hiddenCount}
          />
        </Box>
      </Box>

      <SurveyOptions
        onSelect={outcome => {
          setInputValue('')
          onOutcome(outcome)
        }}
      />
    </Box>
  )
}

type BodyProps = {
  record: MemoryWriteRecord
  summary: string | null
  truncated: boolean
  maxLines: number
  width: number
  hiddenCount: number
}

/** Bundle `TG5`: the recorded content, summarized/diffed/truncated. */
function MemoryWriteSurveyBody({
  record,
  summary,
  truncated,
  maxLines,
  width,
  hiddenCount,
}: BodyProps): React.ReactNode {
  // Long writes with a summary show the one-sentence summary instead of the
  // raw content.
  if (summary && truncated) {
    return (
      <>
        <Text wrap="wrap">{summary}</Text>
        {hiddenCount > 0 && <HiddenLineCount count={hiddenCount} />}
      </>
    )
  }

  // Edits render as a diff (truncated to maxLines).
  if (record.isEdit && record.structuredPatch.length > 0) {
    const hunks = truncated
      ? truncateHunks(record.structuredPatch, maxLines)
      : record.structuredPatch
    return (
      <>
        <StructuredDiffList
          hunks={hunks}
          dim={false}
          width={width}
          filePath={record.filePath}
          firstLine={null}
        />
        {truncated && hiddenCount > 0 && (
          <HiddenLineCount count={hiddenCount} />
        )}
      </>
    )
  }

  // New files show the body text (truncated to maxLines).
  const lines = record.body.split('\n')
  const shown = truncated ? lines.slice(0, maxLines) : lines
  return (
    <>
      <Text wrap="wrap">{shown.join('\n')}</Text>
      {truncated && hiddenCount > 0 && <HiddenLineCount count={hiddenCount} />}
    </>
  )
}

/** Truncate hunks to at most `maxLines` total lines. Bundle `vG5`. */
function truncateHunks(
  hunks: StructuredPatchHunk[],
  maxLines: number,
): StructuredPatchHunk[] {
  const out: StructuredPatchHunk[] = []
  let remaining = maxLines
  for (const hunk of hunks) {
    if (remaining <= 0) {
      break
    }
    if (hunk.lines.length <= remaining) {
      out.push(hunk)
      remaining -= hunk.lines.length
    } else {
      out.push({ ...hunk, lines: hunk.lines.slice(0, remaining) })
      remaining = 0
    }
  }
  return out
}

/** "… +N lines" indicator for content that did not fit. Bundle `Lj`/`V$6`. */
function HiddenLineCount({ count }: { count: number }): React.ReactNode {
  if (count <= 0) {
    return null
  }
  return (
    <Text dimColor>{`… +${count} ${count === 1 ? 'line' : 'lines'}`}</Text>
  )
}

type OptionsProps = {
  onSelect: (outcome: Outcome) => void
}

/** The "1: Keep  2: Undo" option row. Bundle `XD8`. */
function SurveyOptions({ onSelect }: OptionsProps): React.ReactNode {
  return (
    <Box marginLeft={2} marginTop={1}>
      {OPTIONS.map(({ key, label }) => (
        <Box width={OPTION_WIDTH} key={key}>
          <Text>
            <Text color="ansi:cyan">{key}</Text>: {label}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
