import { writeFile } from 'fs/promises'
import figures from 'figures'
import { join } from 'path'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import wrapText from '../ink/wrap-text.js'
import { useSetAppState } from '../state/AppState.js'
import { archiveRemoteSession } from '../utils/teleport.js'
import { getCwd } from '../utils/cwd.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { createSystemMessage } from '../utils/messages.js'
import { updateTaskState } from '../utils/task/framework.js'
import { flushSessionStorage } from '../utils/sessionStorage.js'
import type { AppState } from '../state/AppState.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import type { Message } from '../types/message.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Choice = 'here' | 'fresh' | 'cancel'

type Props = {
  plan: string
  sessionId: string
  taskId: string
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  readFileState: FileStateCache
  getAppState: () => AppState
  setConversationId: (id: `${string}-${string}-${string}-${string}-${string}`) => void
  resetTerminalTitle?: () => void
}

const MAX_PREVIEW_ROWS = 24
const PREVIEW_CHROME = 11

/** Official 2.1.98 S45. */
export function UltraplanChoiceDialog({
  plan,
  sessionId,
  taskId,
  setMessages,
  readFileState,
  getAppState,
  setConversationId,
  resetTerminalTitle,
}: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const { rows, columns } = useTerminalSize()
  const previewRows = Math.min(
    MAX_PREVIEW_ROWS,
    Math.max(1, Math.floor(rows / 2) - PREVIEW_CHROME),
  )
  const wrapped = useMemo(
    () => wrapText(plan, Math.max(1, columns - 4), 'wrap').split('\n'),
    [plan, columns],
  )
  const maxScroll = Math.max(0, wrapped.length - previewRows)
  const [scroll, setScroll] = useState(0)

  useEffect(() => {
    setScroll(s => Math.min(s, maxScroll))
  }, [maxScroll])

  const canScroll = wrapped.length > previewRows
  useInput((input, key) => {
    if (!canScroll) return
    const page = Math.max(1, Math.floor(previewRows / 2))
    if ((key.ctrl && input === 'd') || key.downArrow) {
      const delta = key.downArrow ? 3 : page
      setScroll(s => Math.min(s + delta, maxScroll))
    } else if ((key.ctrl && input === 'u') || key.upArrow) {
      const delta = key.upArrow ? 3 : page
      setScroll(s => Math.max(s - delta, 0))
    }
  })

  const visible = wrapped.slice(scroll, scroll + previewRows).join('\n')

  const finish = () => {
    updateTaskState(taskId, setAppState, task =>
      task.status !== 'running'
        ? task
        : { ...task, status: 'completed', endTime: Date.now() },
    )
    setAppState(prev =>
      prev.ultraplanPendingChoice
        ? {
            ...prev,
            ultraplanPendingChoice: undefined,
            ultraplanSessionUrl: undefined,
          }
        : prev,
    )
    void archiveRemoteSession(sessionId)
  }

  const handleChoice = async (choice: Choice) => {
    switch (choice) {
      case 'here':
        enqueuePendingNotification({
          value: [
            'Ultraplan approved in browser. Here is the plan:',
            '',
            '<ultraplan>',
            plan,
            '</ultraplan>',
            '',
            'The user approved this plan in the remote session. Give them a brief summary, then start implementing.',
          ].join('\n'),
          mode: 'task-notification',
        })
        break
      case 'fresh': {
        const previousId = getSessionId()
        let saved = false
        try {
          await flushSessionStorage()
          saved = true
        } catch {
          saved = false
        }
        const { clearConversation } = await import(
          '../commands/clear/conversation.js'
        )
        await clearConversation({
          setMessages,
          readFileState,
          getAppState,
          setAppState,
          setConversationId,
        })
        resetTerminalTitle?.()
        if (saved) {
          setMessages(prev => [
            ...prev,
            createSystemMessage(
              `Previous session saved · resume with: claude --resume ${previousId}`,
              'suggestion',
            ),
          ])
        }
        enqueuePendingNotification({
          value: `Here is the approved implementation plan:\n\n${plan}\n\nImplement this plan.`,
          mode: 'prompt',
          origin: { kind: 'auto-continuation' as const },
        })
        break
      }
      case 'cancel': {
        const dest = join(getCwd(), `${new Date().toISOString().slice(0, 10)}-ultraplan.md`)
        await writeFile(dest, plan, { encoding: 'utf-8' })
        setMessages(prev => [
          ...prev,
          createSystemMessage(`Ultraplan rejected · Plan saved to ${dest}`, 'suggestion'),
        ])
        break
      }
    }
    finish()
  }

  return (
    <Dialog
      title="Ultraplan approved"
      subtitle="How should the plan be implemented?"
      onCancel={() => {}}
      isCancelActive={false}
      hideInputGuide
    >
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text>{visible}</Text>
          {canScroll && (
            <Text dimColor>
              {scroll > 0 ? figures.arrowUp : ' '}
              {scroll < maxScroll ? figures.arrowDown : ' '} {scroll + 1}–
              {Math.min(scroll + previewRows, wrapped.length)} of {wrapped.length}{' '}
              · ctrl+u/ctrl+d to scroll
            </Text>
          )}
        </Box>
        <Select
          options={[
            {
              label: 'Implement here',
              value: 'here',
              description: 'Inject plan into the current conversation',
            },
            {
              label: 'Start new session',
              value: 'fresh',
              description: 'Clear conversation and start with only the plan',
            },
            {
              label: 'Cancel',
              value: 'cancel',
              description: "Don't implement — save plan and return",
            },
          ]}
          onChange={value => void handleChoice(value as Choice)}
        />
      </Box>
    </Dialog>
  )
}
