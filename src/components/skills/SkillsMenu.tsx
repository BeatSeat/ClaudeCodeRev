import figures from 'figures'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import {
  type Command,
  type CommandBase,
  type CommandResultDisplay,
  getCommandName,
  type PromptCommand,
} from '../../commands.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js'
import { formatTokens } from '../../utils/format.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand

type SkillSource = SettingSource | 'plugin' | 'mcp'

type Props = {
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  commands: Command[]
}

function getSourceLabel(source: SkillSource): string {
  if (source === 'plugin') return 'plugin'
  if (source === 'mcp') return 'mcp'
  return getSettingSourceName(source)
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const skills = useMemo(() => {
    return commands
      .filter(
        (cmd): cmd is SkillCommand =>
          cmd.type === 'prompt' &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'commands_DEPRECATED' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'mcp'),
      )
      .sort(
        (a, b) =>
          String(a.source).localeCompare(String(b.source)) ||
          getCommandName(a).localeCompare(getCommandName(b)),
      )
  }, [commands])

  const [selected, setSelected] = useState(0)
  const { rows } = useModalOrTerminalSize(useTerminalSize())
  // Official 110 VcK: window to modal/terminal rows so fullscreen overflow scrolls.
  const visibleCount = clamp(rows - 8, 4, Math.max(skills.length, 4))
  const scrollOffset = clamp(
    selected - visibleCount + 1,
    0,
    Math.max(0, skills.length - visibleCount),
  )
  const visible = skills.slice(scrollOffset, scrollOffset + visibleCount)
  const moreAbove = scrollOffset
  const moreBelow = skills.length - (scrollOffset + visibleCount)

  const handleCancel = useCallback((): void => {
    onExit('Skills dialog dismissed', { display: 'system' })
  }, [onExit])

  const handlers = useMemo(
    () => ({
      'select:previous': () =>
        setSelected(i => (i - 1 + skills.length) % skills.length),
      'select:next': () => setSelected(i => (i + 1) % skills.length),
      'confirm:no': handleCancel,
      'settings:close': handleCancel,
    }),
    [handleCancel, skills.length],
  )
  useKeybindings(handlers, {
    context: 'Settings',
    isActive: skills.length > 0,
  })

  const closeHint = getShortcutDisplay('confirm:no', 'Confirmation', 'esc')

  if (skills.length === 0) {
    return (
      <Dialog
        title="Skills"
        subtitle="No skills found"
        onCancel={handleCancel}
        hideInputGuide
      >
        <Text dimColor>
          Create skills in .claude/skills/ or ~/.claude/skills/
        </Text>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Skills"
      subtitle={`${skills.length} ${plural(skills.length, 'skill')} · ${closeHint} to close`}
      onCancel={handleCancel}
      hideInputGuide
    >
      <Box flexDirection="column">
        {moreAbove > 0 && (
          <Text dimColor>
            {'  '}
            {figures.arrowUp} {moreAbove} more above
          </Text>
        )}
        {visible.map((skill, idx) => {
          const flatIndex = scrollOffset + idx
          const selectedRow = flatIndex === selected
          const estimatedTokens = estimateSkillFrontmatterTokens(skill)
          const tokenDisplay = `~${formatTokens(estimatedTokens)} tok`
          return (
            <Box key={`${skill.name}-${skill.source}`}>
              <Text color={selectedRow ? 'suggestion' : undefined}>
                {selectedRow ? figures.pointer : ' '}{' '}
              </Text>
              <Text color={selectedRow ? 'suggestion' : undefined}>
                {getCommandName(skill)}
              </Text>
              <Text dimColor>
                {' '}
                · {getSourceLabel(skill.source as SkillSource)} · {tokenDisplay}
              </Text>
            </Box>
          )
        })}
        {moreBelow > 0 && (
          <Text dimColor>
            {'  '}
            {figures.arrowDown} {moreBelow} more below
          </Text>
        )}
      </Box>
      {skills.some(s => s.source === 'plugin') && (
        <Box marginTop={1}>
          <Text dimColor>Plugin skills are managed via /plugin</Text>
        </Box>
      )}
    </Dialog>
  )
}
