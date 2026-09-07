import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useInterval } from 'usehooks-ts'
import type { CommandResultDisplay } from '../../commands.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Markdown } from '../../components/Markdown.js'
import { SpinnerGlyph } from '../../components/Spinner/SpinnerGlyph.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { useTimeout } from '../../hooks/useTimeout.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { setClipboard } from '../../ink/termio/osc.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CacheSafeParams,
  getLastCacheSafeParams,
} from '../../utils/forkedAgent.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import { runSideQuestion } from '../../utils/sideQuestion.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { truncateToWidth } from '../../utils/truncate.js'
import {
  type BtwHistoryEntry,
  getBtwHistory,
  setBtwHistory,
} from './btwHistory.js'

type BtwComponentProps = {
  question: string
  context: ProcessUserInputContext
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

/** Official 2.1.187 `Kjp` / `jjp` / `vul` / `wul`. */
const CHROME_ROWS = 5
const OUTER_CHROME_ROWS = 6
const SCROLL_LINES = 3
const HISTORY_VISIBLE = 5

function truncateBtwLine(text: string, maxWidth: number): string {
  return truncateToWidth(text.replace(/\s+/g, ' ').trim(), maxWidth)
}

function BtwSideQuestion({
  question,
  context,
  onDone,
}: BtwComponentProps): React.ReactNode {
  const [response, setResponse] = useState<string | null>(null)
  const [synthetic, setSynthetic] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [history, setHistory] = useState<BtwHistoryEntry[]>(() => getBtwHistory())
  const historyRef = useRef(history)
  historyRef.current = history
  const viewingIndexRef = useRef<number | null>(null)
  const [viewingIndex, setViewingIndex] = useState<number | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const [copyFlash, setCopyFlash] = useState(0)
  const copiedExpired = useTimeout(2000, copyFlash)
  const showCopied = copyFlash > 0 && !copiedExpired
  const { rows, columns } = useModalOrTerminalSize(useTerminalSize())

  useInterval(() => setFrame(f => f + 1), response || error ? null : 80)

  function resetViewToLive(): void {
    viewingIndexRef.current = null
    setViewingIndex(null)
    scrollRef.current?.scrollTo(0)
  }

  function handleKeyDown(e: KeyboardEvent): void {
    const displayedResponse =
      viewingIndexRef.current !== null
        ? historyRef.current[viewingIndexRef.current]?.response
        : response

    if (
      e.key === 'escape' ||
      e.key === 'return' ||
      e.key === ' ' ||
      (e.ctrl && (e.key === 'c' || e.key === 'd'))
    ) {
      e.preventDefault()
      onDone(undefined, { display: 'skip' })
      return
    }

    if (e.key === 'left' || e.key === 'right') {
      e.preventDefault()
      const len = historyRef.current.length
      if (len === 0) return
      const minIdx = Math.max(0, len - HISTORY_VISIBLE)
      const from = viewingIndexRef.current ?? len
      const next = Math.max(
        minIdx,
        Math.min(len, from + (e.key === 'left' ? -1 : 1)),
      )
      if (next === from) return
      viewingIndexRef.current = next === len ? null : next
      setViewingIndex(viewingIndexRef.current)
      scrollRef.current?.scrollTo(0)
      return
    }

    if (e.key === 'x' && historyRef.current.length > 0) {
      e.preventDefault()
      setBtwHistory(
        response && !synthetic ? [{ question, response }] : [],
      )
      historyRef.current = []
      setHistory([])
      resetViewToLive()
      return
    }

    if (e.key === 'c' && !e.ctrl && !e.meta && displayedResponse) {
      e.preventDefault()
      void setClipboard(displayedResponse).then(raw => {
        if (raw) process.stdout.write(raw)
      })
      setCopyFlash(n => n + 1)
      return
    }

    if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
      e.preventDefault()
      scrollRef.current?.scrollBy(-SCROLL_LINES)
    }
    if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
      e.preventDefault()
      scrollRef.current?.scrollBy(SCROLL_LINES)
    }
  }

  useEffect(() => {
    const abortController = createAbortController()

    async function fetchResponse(): Promise<void> {
      try {
        const cacheSafeParams = await buildCacheSafeParams(context)
        const result = await runSideQuestion({ question, cacheSafeParams })

        if (!abortController.signal.aborted) {
          if (result.response) {
            resetViewToLive()
            setResponse(result.response)
            setSynthetic(result.synthetic)
            // Do NOT refresh history from store here — e6n/aHo already
            // appended the current Q&A for the *next* /btw open; the in-
            // session list stays as prior entries only (official UI).
          } else {
            resetViewToLive()
            setError('No response received')
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          resetViewToLive()
          setError(errorMessage(err) || 'Failed to get response')
        }
      }
    }

    void fetchResponse()

    return () => {
      abortController.abort()
    }
  }, [question, context])

  const visibleHistory = history.slice(-HISTORY_VISIBLE)
  const earlierCount = history.length - visibleHistory.length
  const viewingEntry =
    viewingIndex !== null ? history[viewingIndex] ?? null : null
  const historyRows =
    visibleHistory.length + (earlierCount > 0 ? 1 : 0)
  const questionWidth = Math.max(20, columns - 7)
  const maxContentHeight = Math.max(
    5,
    rows - CHROME_ROWS - OUTER_CHROME_ROWS - historyRows,
  )

  return (
    <Box
      flexDirection="column"
      paddingLeft={2}
      marginTop={1}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {earlierCount > 0 && (
        <Text dimColor>
          (+{earlierCount} earlier /btw)
        </Text>
      )}
      {visibleHistory.map((entry, i) => {
        const absoluteIndex = earlierCount + i
        return (
          <Text
            key={absoluteIndex}
            dimColor={viewingIndex !== absoluteIndex}
            bold={viewingIndex === absoluteIndex}
          >
            /btw {truncateBtwLine(entry.question, questionWidth)}
          </Text>
        )
      })}
      <Box>
        <Text
          color={viewingEntry ? undefined : 'warning'}
          bold={!viewingEntry}
          dimColor={!!viewingEntry}
        >
          /btw{' '}
        </Text>
        <Text dimColor>{truncateBtwLine(question, questionWidth)}</Text>
      </Box>
      <Box marginTop={1} marginLeft={2} maxHeight={maxContentHeight}>
        <ScrollBox
          ref={scrollRef}
          flexDirection="column"
          flexGrow={1}
          stickyScroll={false}
        >
          {viewingEntry ? (
            <Markdown>{viewingEntry.response}</Markdown>
          ) : error ? (
            <Text color="error">{error}</Text>
          ) : response ? (
            <Markdown>{response}</Markdown>
          ) : (
            <Box>
              <SpinnerGlyph frame={frame} messageColor="warning" />
              <Text color="warning">Answering…</Text>
            </Box>
          )}
        </ScrollBox>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          <Byline>
            {history.length > 0 ? (
              <KeyboardShortcutHint
                chord={['left', 'right']}
                action="switch"
              />
            ) : (
              (viewingEntry || response || error) && (
                <KeyboardShortcutHint
                  chord={['up', 'down']}
                  action="scroll"
                />
              )
            )}
            {(viewingEntry || response) &&
              (showCopied ? (
                <Text color="success">Copied to clipboard</Text>
              ) : (
                <KeyboardShortcutHint chord="c" action="copy" />
              ))}
            {history.length > 0 && (
              <KeyboardShortcutHint chord="x" action="clear history" />
            )}
            <KeyboardShortcutHint chord="escape" action="close" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Build CacheSafeParams for the side question fork.
 *
 * The preferred source is getLastCacheSafeParams — the exact
 * systemPrompt/userContext/systemContext bytes the main thread sent on its
 * last request (captured in stopHooks). Reusing them guarantees a byte-
 * identical prefix and thus a prompt cache hit. We pair these with the
 * current toolUseContext (for thinkingConfig/tools) and current messages
 * (for up-to-date context).
 *
 * Fallback (first turn before stop hooks fire, or prompt-suggestion
 * disabled): rebuild from scratch. This may miss the cache if the main loop
 * applied buildEffectiveSystemPrompt extras (--agent, --system-prompt,
 * --append-system-prompt, coordinator mode).
 */
function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

async function buildCacheSafeParams(
  context: ProcessUserInputContext,
): Promise<CacheSafeParams> {
  const forkContextMessages = getMessagesAfterCompactBoundary(
    stripInProgressAssistantMessage(context.messages),
  )
  const saved = getLastCacheSafeParams()
  if (saved) {
    return {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      systemContext: saved.systemContext,
      toolUseContext: context,
      forkContextMessages,
    }
  }
  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      context.options.mcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt: asSystemPrompt(rawSystemPrompt),
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ProcessUserInputContext,
  args: string,
): Promise<React.ReactNode> {
  const question = args?.trim()

  if (!question) {
    onDone('Usage: /btw <your question>', { display: 'system' })
    return null
  }

  saveGlobalConfig(current => ({
    ...current,
    btwUseCount: current.btwUseCount + 1,
  }))

  return (
    <BtwSideQuestion question={question} context={context} onDone={onDone} />
  )
}
