import React, { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { POWERUP_LESSONS, type PowerupLesson } from './lessons.js'

function loadUnlocked(): Set<string> {
  const ids = new Set(POWERUP_LESSONS.map(l => l.id))
  return new Set((getGlobalConfig().powerupsUnlocked ?? []).filter(id => ids.has(id)))
}

function LessonView({
  lesson,
  isUnlocked,
  onDone,
  onBack,
}: {
  lesson: PowerupLesson
  isUnlocked: boolean
  onDone: () => void
  onBack: () => void
}) {
  useInput((_input, key) => {
    if (key.escape || key.leftArrow) {
      onBack()
      return
    }
    if (key.return) {
      onDone()
    }
  })
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color="claude">
        {lesson.title}
      </Text>
      <Text dimColor>{lesson.tagline}</Text>
      {lesson.body}
      <Text dimColor>
        {isUnlocked ? 'already unlocked · enter or esc to go back' : 'enter to complete · esc to go back'}
      </Text>
    </Box>
  )
}

function PowerupHome({
  onExit,
}: {
  onExit: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
}) {
  const [unlocked, setUnlocked] = useState(loadUnlocked)
  const [selected, setSelected] = useState(0)
  const [open, setOpen] = useState<PowerupLesson | null>(null)
  const [allDone, setAllDone] = useState(unlocked.size === POWERUP_LESSONS.length)

  function openLesson(lesson: PowerupLesson) {
    logEvent('tengu_powerup_lesson_opened', {
      lesson_id:
        lesson.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      was_already_unlocked: unlocked.has(lesson.id),
      unlocked_count: unlocked.size,
    })
    setOpen(lesson)
  }

  function completeLesson(id: string) {
    if (unlocked.has(id)) return
    const next = new Set(unlocked).add(id)
    setUnlocked(next)
    saveGlobalConfig(current => ({
      ...current,
      powerupsUnlocked: [...next],
    }))
    logEvent('tengu_powerup_lesson_completed', {
      lesson_id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      unlocked_count: next.size,
      all_unlocked: next.size === POWERUP_LESSONS.length,
    })
    if (next.size === POWERUP_LESSONS.length) setAllDone(true)
  }

  useInput((input, key) => {
    if (open) return
    if (key.escape) {
      onExit(undefined, { display: 'system' })
      return
    }
    if (key.upArrow) {
      setSelected(i => (i - 1 + POWERUP_LESSONS.length) % POWERUP_LESSONS.length)
      return
    }
    if (key.downArrow) {
      setSelected(i => (i + 1) % POWERUP_LESSONS.length)
      return
    }
    if (key.return) {
      const lesson = POWERUP_LESSONS[selected]
      if (lesson) openLesson(lesson)
    }
    if (input === 'q') onExit(undefined, { display: 'system' })
  })

  if (open) {
    return (
      <LessonView
        lesson={open}
        isUnlocked={unlocked.has(open.id)}
        onBack={() => setOpen(null)}
        onDone={() => {
          completeLesson(open.id)
          setOpen(null)
        }}
      />
    )
  }

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Text bold color="claude">
        /powerup
      </Text>
      <Text dimColor>
        Discover Claude Code features through quick interactive lessons
      </Text>
      {POWERUP_LESSONS.map((lesson, i) => {
        const active = i === selected
        const done = unlocked.has(lesson.id)
        return (
          <Box key={lesson.id}>
            <Text color={active ? 'suggestion' : undefined} inverse={active}>
              {done ? '✓' : '·'} {lesson.title}
            </Text>
            <Text dimColor> {lesson.tagline}</Text>
          </Box>
        )
      })}
      {allDone ? (
        <Text color="success">all lessons unlocked</Text>
      ) : (
        <Text dimColor>
          {unlocked.size}/{POWERUP_LESSONS.length} unlocked · enter to open ·
          esc to exit
        </Text>
      )}
    </Box>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <PowerupHome onExit={onDone} />
}
