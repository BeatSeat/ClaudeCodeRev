import React, { useEffect, useState } from 'react'
import { getCompanion, roll, companionUserId } from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import {
  RARITY_COLORS,
  RARITY_STARS,
  STAT_NAMES,
  type Companion,
  type CompanionBones,
  type CompanionSoul,
  type StatName,
} from '../../buddy/types.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getRainbowColor } from '../../utils/thinking.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

const EGG: string[] = [
  '    _____    ',
  '   /     \\   ',
  '  /       \\  ',
  ' |         | ',
  '  \\       /  ',
  '   \\_____/   ',
]

const HATCH_FRAMES: Array<{ offset: number; lines: string[] }> = [
  { offset: 0, lines: EGG },
  { offset: 1, lines: EGG },
  { offset: -1, lines: EGG },
  { offset: 1, lines: EGG },
  {
    offset: 0,
    lines: [
      '    _____    ',
      '   /     \\   ',
      '  /       \\  ',
      ' |    .    | ',
      '  \\       /  ',
      '   \\_____/   ',
    ],
  },
  {
    offset: -1,
    lines: [
      '    _____    ',
      '   /     \\   ',
      '  /       \\  ',
      ' |    ∕    | ',
      '  \\       /  ',
      '   \\_____/   ',
    ],
  },
  {
    offset: 1,
    lines: [
      '    _____    ',
      '   /     \\   ',
      '  /   .   \\  ',
      ' |   ∕ \\   | ',
      '  \\       /  ',
      '   \\_____/   ',
    ],
  },
  {
    offset: 0,
    lines: [
      '    _____    ',
      '   /  .  \\   ',
      '  /  ∕ \\  \\  ',
      ' |  ∕   \\  | ',
      '  \\   .   /  ',
      '   \\_____/   ',
    ],
  },
  {
    offset: -1,
    lines: [
      '    _____    ',
      '   / ∕ \\ \\   ',
      '  / ∕   \\ \\  ',
      ' | ∕     \\ | ',
      '  \\   ∨   /  ',
      '   \\__∨__/   ',
    ],
  },
  {
    offset: 1,
    lines: [
      '    __ __    ',
      '   / V V \\   ',
      '  / ∕   \\ \\  ',
      ' | ∕     \\ | ',
      '  \\   ∨   /  ',
      '   \\__∨__/   ',
    ],
  },
  {
    offset: 0,
    lines: [
      '   ·  ✦  ·   ',
      '  ·       ·  ',
      ' ·    ✦    · ',
      '  ✦       ✦  ',
      ' ·    ·    · ',
      '   ·  ✦  ·   ',
    ],
  },
]

const SHAKE_FRAMES = 4
const TICK_MS = 160
const SHAKE_LOOPS = 3

function localSoul(bones: CompanionBones): CompanionSoul {
  const peak = STAT_NAMES.reduce(
    (best, name) => (bones.stats[name] > bones.stats[best] ? name : best),
    STAT_NAMES[0],
  )
  const title = bones.species.charAt(0).toUpperCase() + bones.species.slice(1)
  return {
    name: bones.shiny ? `Shiny ${title}` : title,
    personality: `${bones.rarity} ${bones.species} with peak ${peak.toLowerCase()}`,
  }
}

async function hatchCompanion(): Promise<Companion> {
  const { bones } = roll(companionUserId())
  const soul = localSoul(bones)
  const hatchedAt = Date.now()
  saveGlobalConfig(current => ({
    ...current,
    companion: { ...soul, hatchedAt },
    companionMuted: false,
  }))
  return { ...bones, ...soul, hatchedAt }
}

function StatBar({ name, value }: { name: StatName; value: number }) {
  const filled = Math.max(0, Math.min(10, Math.round(value / 10)))
  return (
    <Text>
      {name.padEnd(10)} {'█'.repeat(filled)}
      {'░'.repeat(10 - filled)} {value}
    </Text>
  )
}

function CompanionCard({
  companion,
  lastReaction,
  onDone,
}: {
  companion: Companion
  lastReaction?: string
  onDone?: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
}) {
  const color = RARITY_COLORS[companion.rarity]
  useInput(() => {
    onDone?.(undefined, { display: 'skip' })
  })
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={2}
      paddingY={1}
      width={40}
    >
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {RARITY_STARS[companion.rarity]} {companion.rarity.toUpperCase()}
        </Text>
        <Text color={color}>{companion.species.toUpperCase()}</Text>
      </Box>
      {companion.shiny ? (
        <Text color="warning" bold>
          ✨ SHINY ✨
        </Text>
      ) : null}
      <Box flexDirection="column" marginY={1}>
        {renderSprite(companion).map((line, i) => (
          <Text key={i} color={color}>
            {line}
          </Text>
        ))}
      </Box>
      <Text bold>{companion.name}</Text>
      <Box marginY={1}>
        <Text dimColor italic>
          "{companion.personality}"
        </Text>
      </Box>
      <Box flexDirection="column">
        {STAT_NAMES.map(name => (
          <StatBar key={name} name={name} value={companion.stats[name]} />
        ))}
      </Box>
      {lastReaction ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>last said</Text>
          <Box borderStyle="round" borderColor="inactive" paddingX={1}>
            <Text dimColor italic>
              {lastReaction}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}

function HatchScreen({
  hatching,
  onDone,
}: {
  hatching: Promise<Companion>
  onDone: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
}) {
  const { columns } = useTerminalSize()
  const [tick, setTick] = useState(0)
  const [companion, setCompanion] = useState<Companion | null>(null)
  const [revealAt, setRevealAt] = useState<number | null>(null)
  const [revealed, setRevealed] = useState<Companion | null>(null)
  const shakeBudget = SHAKE_LOOPS * SHAKE_FRAMES

  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), TICK_MS)
    void hatching.then(setCompanion)
    return () => clearInterval(id)
  }, [hatching])

  useEffect(() => {
    if (revealAt === null && companion !== null && tick >= shakeBudget) {
      setRevealAt(tick)
    }
  }, [companion, revealAt, tick, shakeBudget])

  useEffect(() => {
    if (revealed || !companion || revealAt === null) return
    const burst = tick - revealAt
    if (burst >= HATCH_FRAMES.length - SHAKE_FRAMES) {
      setRevealed(companion)
    }
  }, [companion, revealAt, revealed, tick])

  useInput(() => {
    if (revealed) onDone(undefined, { display: 'skip' })
  })

  if (revealed) {
    return (
      <Box flexDirection="column">
        <CompanionCard companion={revealed} onDone={onDone} />
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {revealed.name} is here · it'll chime in as you code
          </Text>
          <Text dimColor>your buddy won't count toward your usage</Text>
          <Text dimColor>
            say its name to get its take · /buddy pet · /buddy off
          </Text>
          <Box marginTop={1}>
            <Text dimColor>press any key</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  let frameIndex: number
  if (revealAt === null) {
    frameIndex = tick % SHAKE_FRAMES
  } else {
    const burst = tick - revealAt
    frameIndex =
      burst < HATCH_FRAMES.length - SHAKE_FRAMES
        ? SHAKE_FRAMES + burst
        : HATCH_FRAMES.length - 1
  }
  const frame = HATCH_FRAMES[frameIndex] ?? HATCH_FRAMES[0]!
  const left = ' '.repeat(1 + Math.max(0, frame.offset))
  const right = ' '.repeat(1 + Math.max(0, -frame.offset))

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      width={columns}
      borderStyle="round"
      borderColor={getRainbowColor(tick)}
      paddingY={1}
    >
      {frame.lines.map((line, i) => (
        <Text key={i}>
          {left}
          {line}
          {right}
        </Text>
      ))}
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        <Text dimColor>hatching a coding buddy…</Text>
        <Text dimColor>
          it'll watch you work and occasionally have opinions
        </Text>
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const config = getGlobalConfig()
  const arg = args?.trim()
  if (arg === 'pet') {
    const companion = getCompanion()
    if (!companion) {
      onDone('no companion yet · run /buddy first', { display: 'system' })
      return null
    }
    if (config.companionMuted === true) {
      saveGlobalConfig(current => ({ ...current, companionMuted: false }))
    }
    context.setAppState(prev => ({ ...prev, companionPetAt: Date.now() }))
    onDone(`petted ${companion.name}`, { display: 'system' })
    return null
  }
  if (arg === 'off') {
    if (config.companionMuted !== true) {
      saveGlobalConfig(current => ({ ...current, companionMuted: true }))
    }
    onDone('companion muted', { display: 'system' })
    return null
  }
  if (arg === 'on') {
    if (config.companionMuted === true) {
      saveGlobalConfig(current => ({ ...current, companionMuted: false }))
    }
    onDone('companion unmuted', { display: 'system' })
    return null
  }
  if (config.companionMuted === true) {
    saveGlobalConfig(current => ({ ...current, companionMuted: false }))
  }
  const existing = getCompanion()
  if (existing) {
    return (
      <CompanionCard
        companion={existing}
        lastReaction={context.getAppState().companionReaction}
        onDone={onDone}
      />
    )
  }
  const hatching = hatchCompanion()
  return <HatchScreen hatching={hatching} onDone={onDone} />
}
