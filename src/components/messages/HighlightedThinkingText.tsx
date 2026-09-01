import figures from 'figures'
import * as React from 'react'
import { useContext } from 'react'
import { useQueuedMessage } from '../../context/QueuedMessageContext.js'
import { Box, Text } from '../../ink.js'
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js'
import {
  findThinkingTriggerPositions,
  getRainbowColor,
  isUltrathinkEnabled,
} from '../../utils/thinking.js'
import { Divider } from '../design-system/Divider.js'
import { MessageActionsSelectedContext } from '../messageActions.js'

export type TruncatedPromptDisplay = {
  head: string
  hiddenLines: number
  tail: string
}

type Props = {
  text: string | TruncatedPromptDisplay
  useBriefLayout?: boolean
  timestamp?: string
}

function isTruncated(
  text: string | TruncatedPromptDisplay,
): text is TruncatedPromptDisplay {
  return typeof text === 'object'
}

function HiddenLinesRule({
  hiddenLines,
  indent,
}: {
  hiddenLines: number
  indent: number
}): React.ReactNode {
  const title = `(${hiddenLines} ${hiddenLines === 1 ? 'line' : 'lines'} hidden)`
  return (
    <Divider
      title={title}
      titleAlign="start"
      color="subtle"
      padding={indent}
    />
  )
}

function HighlightedPlainText({ text }: { text: string }): React.ReactNode {
  const triggers = isUltrathinkEnabled()
    ? findThinkingTriggerPositions(text)
    : []

  if (triggers.length === 0) {
    return <Text color="text">{text}</Text>
  }

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const t of triggers) {
    if (t.start > cursor) {
      parts.push(
        <Text key={`plain-${cursor}`} color="text">
          {text.slice(cursor, t.start)}
        </Text>,
      )
    }
    for (let i = t.start; i < t.end; i++) {
      parts.push(
        <Text key={`rb-${i}`} color={getRainbowColor(i - t.start)}>
          {text[i]}
        </Text>,
      )
    }
    cursor = t.end
  }
  if (cursor < text.length) {
    parts.push(
      <Text key={`plain-${cursor}`} color="text">
        {text.slice(cursor)}
      </Text>,
    )
  }

  return <Text>{parts}</Text>
}

export function HighlightedThinkingText({
  text,
  useBriefLayout,
  timestamp,
}: Props): React.ReactNode {
  // Brief/assistant mode: chat-style "You" label instead of the ❯ highlight.
  // Parent drops its backgroundColor when this is true, so no grey shows
  // through. No manual wrap needed — Ink wraps inside the parent Box.
  const queued = useQueuedMessage()
  const isQueued = queued?.isQueued ?? false
  const isSelected = useContext(MessageActionsSelectedContext)
  const pointerColor = isSelected ? 'suggestion' : 'subtle'
  const truncated = isTruncated(text)

  if (useBriefLayout) {
    const ts = timestamp ? formatBriefTimestamp(timestamp) : ''
    const color = isQueued ? 'subtle' : 'text'
    const body = truncated ? (
      <>
        <Text color={color}>{text.head}</Text>
        <HiddenLinesRule hiddenLines={text.hiddenLines} indent={2} />
        <Text color={color}>{text.tail}</Text>
      </>
    ) : (
      <Text color={color}>{text}</Text>
    )
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text color={isQueued ? 'subtle' : 'briefLabelYou'}>You</Text>
          {ts ? <Text dimColor> {ts}</Text> : null}
        </Box>
        {body}
      </Box>
    )
  }

  const indent = 3 + (queued?.paddingWidth ?? 0)
  const content = truncated ? (
    <Box flexDirection="column">
      <HighlightedPlainText text={text.head} />
      <HiddenLinesRule hiddenLines={text.hiddenLines} indent={indent} />
      <HighlightedPlainText text={text.tail} />
    </Box>
  ) : (
    <HighlightedPlainText text={text} />
  )

  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text color={pointerColor}>{figures.pointer} </Text>
      </Box>
      {content}
    </Box>
  )
}
