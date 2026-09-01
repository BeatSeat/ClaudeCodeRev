import figures from 'figures'
import * as React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  type Command,
  type CommandBase,
  type CommandResultDisplay,
  getCommandName,
  type PromptCommand,
} from '../../commands.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useSearchInput } from '../../hooks/useSearchInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useTerminalFocus } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { PasteEvent } from '../../ink/events/paste-event.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js'
import { formatTokens } from '../../utils/format.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import {
  getSharedSkillOverride,
  getSkillOverrideLock,
  SKILL_OVERRIDE_CYCLE,
  type SkillOverride,
  type SkillOverrideLock,
} from '../../utils/settings/skillOverrides.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { SearchBox } from '../SearchBox.js'
import { clearCommandMemoizationCaches } from '../../commands.js'

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

/** Official 2.1.129 `SA5`. */
const OVERRIDE_DISPLAY: Record<
  SkillOverride,
  { glyph: string; label: string; color?: 'success' | 'warning' | 'error' }
> = {
  on: { glyph: figures.tick, label: 'on', color: 'success' },
  'name-only': { glyph: figures.bullet, label: 'name-only' },
  'user-invocable-only': {
    glyph: figures.circle,
    label: 'user-only',
    color: 'warning',
  },
  off: { glyph: figures.cross, label: 'off', color: 'error' },
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const [sortByTokens, setSortByTokens] = useState(false)
  const skills = useMemo(() => {
    const filtered = commands.filter(
      (cmd): cmd is SkillCommand =>
        cmd.type === 'prompt' &&
        (cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.loadedFrom === 'plugin' ||
          cmd.loadedFrom === 'mcp'),
    )
    if (sortByTokens) {
      const tokens = new Map(
        filtered.map(cmd => [cmd, estimateSkillFrontmatterTokens(cmd)]),
      )
      return filtered.sort(
        (a, b) =>
          (tokens.get(b) ?? 0) - (tokens.get(a) ?? 0) ||
          getCommandName(a).localeCompare(getCommandName(b)),
      )
    }
    return filtered.sort(
      (a, b) =>
        String(a.source).localeCompare(String(b.source)) ||
        getCommandName(a).localeCompare(getCommandName(b)),
    )
  }, [commands, sortByTokens])

  // Official 2.1.129 `m94`: the dialog became an editor for skillOverrides.
  // 128 rendered the same list read-only because the override lookup was a
  // stub that always answered "on".
  const localOverrides = useMemo(
    () => getSettingsForSource('localSettings')?.skillOverrides ?? {},
    [],
  )
  const sharedOverrides = useMemo(() => {
    const map = new Map<string, SkillOverride>()
    for (const skill of skills) {
      const shared = getSharedSkillOverride(skill.name)
      if (shared) map.set(skill.name, shared)
    }
    return map
  }, [skills])
  const locks = useMemo(() => {
    const map = new Map<SkillCommand, SkillOverrideLock>()
    for (const skill of skills) {
      const lock = getSkillOverrideLock(skill, skill.name)
      if (lock) map.set(skill, lock)
    }
    return map
  }, [skills])
  const [overrides, setOverrides] = useState<Record<string, SkillOverride>>(
    () => {
      const initial: Record<string, SkillOverride> = {}
      for (const skill of skills) {
        if (skill.name in initial) continue
        initial[skill.name] =
          locks.get(skill)?.value ??
          localOverrides[skill.name] ??
          sharedOverrides.get(skill.name) ??
          'on'
      }
      return initial
    },
  )

  const [isSearchMode, setIsSearchMode] = useState(false)
  const consumedRef = useRef(false)
  const {
    query,
    setQuery,
    cursorOffset,
    handleKeyDown: searchKeyDown,
    handlePaste: searchPaste,
  } = useSearchInput({
    isActive: isSearchMode,
    onExit: () => {
      consumedRef.current = false
      setIsSearchMode(false)
    },
    passthroughCtrlKeys: ['c', 'd'],
    useGlobalInputFallback: false,
  })
  const isTerminalFocused = useTerminalFocus()

  const visibleSkills = useMemo(() => {
    if (!query) return skills
    const q = query.toLowerCase()
    return skills.filter(
      skill =>
        skill.name.toLowerCase().includes(q) ||
        (skill.description ?? '').toLowerCase().includes(q) ||
        getSourceLabel(skill.source as SkillSource)
          .toLowerCase()
          .includes(q),
    )
  }, [skills, query])

  const [selected, setSelected] = useState(0)
  const { rows } = useModalOrTerminalSize(useTerminalSize())
  // Official 121: SearchBox chrome — window is rows-13 (120 was rows-10 / this tree rows-8).
  const visibleCount = clamp(rows - 13, 4, Math.max(visibleSkills.length, 4))
  const scrollOffset = clamp(
    selected - visibleCount + 1,
    0,
    Math.max(0, visibleSkills.length - visibleCount),
  )
  const visible = visibleSkills.slice(scrollOffset, scrollOffset + visibleCount)
  const moreAbove = scrollOffset
  const moreBelow = visibleSkills.length - (scrollOffset + visibleCount)

  const handleCancel = useCallback((): void => {
    onExit('Skills dialog dismissed', { display: 'system' })
  }, [onExit])

  const cycleOverride = useCallback((): void => {
    const skill = visibleSkills[selected]
    if (!skill || locks.has(skill)) return
    setOverrides(prev => {
      const current = prev[skill.name] ?? 'on'
      const next =
        SKILL_OVERRIDE_CYCLE[
          (SKILL_OVERRIDE_CYCLE.indexOf(current) + 1) %
            SKILL_OVERRIDE_CYCLE.length
        ]!
      return { ...prev, [skill.name]: next }
    })
  }, [visibleSkills, selected, locks])

  const handleSave = useCallback((): void => {
    // A locked skill keeps whatever the policy/flag/author decided, so it is
    // never written and never counted as changed.
    const seen = new Set(Array.from(locks.keys(), skill => skill.name))
    const toPersist: Record<string, SkillOverride | undefined> = {}
    let writeCount = 0
    let changeCount = 0
    for (const skill of skills) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      const value = overrides[skill.name] ?? 'on'
      const shared = sharedOverrides.get(skill.name) ?? 'on'
      const effective = localOverrides[skill.name] ?? shared
      // A local override that just restates the project/user value is dropped
      // rather than duplicated into settings.local.json.
      const persisted = value === shared ? undefined : value
      if (persisted !== localOverrides[skill.name]) {
        toPersist[skill.name] = persisted
        writeCount++
      }
      if (value !== effective) changeCount++
    }

    if (writeCount > 0) {
      const { error } = updateSettingsForSource('localSettings', {
        skillOverrides: toPersist as Record<string, SkillOverride>,
      })
      if (error) {
        onExit(`Failed to save skill overrides: ${error.message}`, {
          display: 'system',
        })
        return
      }
      clearCommandMemoizationCaches()
    }

    onExit(
      changeCount > 0
        ? `Updated ${changeCount} skill ${plural(changeCount, 'override')}`
        : 'No changes',
      { display: 'system' },
    )
  }, [locks, skills, overrides, sharedOverrides, localOverrides, onExit])

  const handlers = useMemo(
    () => ({
      'select:previous': () =>
        setSelected(i => (i - 1 + visibleSkills.length) % visibleSkills.length),
      'select:next': () => setSelected(i => (i + 1) % visibleSkills.length),
      'select:accept': cycleOverride,
      'confirm:no': handleCancel,
      'settings:close': handleSave,
      'settings:sortByTokens': () => {
        setSortByTokens(prev => !prev)
        setSelected(0)
      },
    }),
    [handleCancel, handleSave, cycleOverride, visibleSkills.length],
  )
  useKeybindings(handlers, {
    context: 'Settings',
    isActive: !isSearchMode && visibleSkills.length > 0,
  })
  useKeybindings(
    { 'confirm:no': handleCancel },
    { context: 'Settings', isActive: !isSearchMode },
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (consumedRef.current) {
        searchKeyDown(e)
        return
      }
      if (e.ctrl || e.meta) return
      if (e.key === 'backspace') {
        if (query) {
          e.preventDefault()
          consumedRef.current = true
          setIsSearchMode(true)
          setQuery(query.slice(0, -1))
        }
        return
      }
      if (e.key.length > 1) return
      if (e.key.length >= 1 && e.key !== ' ') {
        e.preventDefault()
        consumedRef.current = true
        setIsSearchMode(true)
        const ch = e.key.startsWith('/') ? e.key.slice(1) : e.key
        setQuery(query + ch)
      }
    },
    [searchKeyDown, setQuery, query],
  )

  const handlePaste = useCallback(
    (e: PasteEvent): void => {
      if (consumedRef.current) {
        searchPaste(e)
        return
      }
      const line = e.text.split(/\r\n|\r|\n/, 2)[0] ?? ''
      if (line.length === 0) return
      e.preventDefault()
      consumedRef.current = true
      setIsSearchMode(true)
      const text = line.startsWith('/') ? line.slice(1) : line
      setQuery(query + text)
    },
    [searchPaste, setQuery, query],
  )

  const closeHint = getShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const sortHint = getShortcutDisplay(
    'settings:sortByTokens',
    'Settings',
    't',
  )
  const saveHint = getShortcutDisplay('settings:close', 'Settings', 'enter')
  const cycleHint = getShortcutDisplay('select:accept', 'Settings', 'space')

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

  const countLabel = query
    ? `${visibleSkills.length}/${skills.length} ${plural(skills.length, 'skill')}`
    : `${skills.length} ${plural(skills.length, 'skill')}`
  const filterHint = isSearchMode
    ? 'type to filter · ↓/enter to select · esc to clear'
    : visibleSkills.length === 0
      ? `/ to search, ${closeHint} to cancel`
      : `${cycleHint} to cycle, ${saveHint} to save, / to search, ${sortHint} to sort, ${closeHint} to cancel`

  return (
    <Dialog
      title="Skills"
      subtitle={`${countLabel}${sortByTokens ? ' · sorted by tokens' : ''} · ${filterHint}`}
      onCancel={handleCancel}
      isCancelActive={false}
      hideInputGuide
    >
      <Box
        flexDirection="column"
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      >
        <SearchBox
          query={query}
          isFocused={isSearchMode}
          isTerminalFocused={isTerminalFocused}
          cursorOffset={cursorOffset}
          placeholder="Search skills…"
        />
        {visibleSkills.length === 0 ? (
          <Box marginTop={1}>
            <Text>{`No skills match "${query}"`}</Text>
          </Box>
        ) : (
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
              const lock = locks.get(skill)
              const state = lock?.value ?? overrides[skill.name] ?? 'on'
              const display = OVERRIDE_DISPLAY[state]
              return (
                <Box key={`${skill.name}-${skill.source}`}>
                  <Text color={selectedRow ? 'suggestion' : undefined}>
                    {selectedRow ? figures.pointer : ' '}{' '}
                  </Text>
                  {lock ? (
                    <Text dimColor>{'🔒 ' + display.label.padEnd(9)}</Text>
                  ) : (
                    <Text color={display.color}>
                      {display.glyph} {display.label.padEnd(9)}
                    </Text>
                  )}
                  <Text>{'  '}</Text>
                  <Text color={selectedRow ? 'suggestion' : undefined}>
                    {getCommandName(skill)}
                  </Text>
                  <Text dimColor>
                    {' '}
                    · {getSourceLabel(skill.source as SkillSource)} ·{' '}
                    {tokenDisplay}
                    {lock ? ` · locked by ${lock.source}` : ''}
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
