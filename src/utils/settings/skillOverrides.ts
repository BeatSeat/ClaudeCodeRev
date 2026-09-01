/**
 * Official 2.1.129 `na` / `RA5` / `CA5`: per-skill availability overrides.
 *
 * 128 shipped the settings plumbing but the lookup was a stub that always
 * answered "on", so `off` / `user-invocable-only` / `name-only` had no effect.
 */

import type { Command, PromptCommand } from '../../types/command.js'
import { getInitialSettings, getSettingsForSource } from './settings.js'

export type SkillOverride = 'on' | 'off' | 'user-invocable-only' | 'name-only'

/** Cycle order used by the Skills dialog. */
export const SKILL_OVERRIDE_CYCLE: readonly SkillOverride[] = [
  'on',
  'name-only',
  'user-invocable-only',
  'off',
]

export type SkillOverrideLock = {
  value: SkillOverride
  source: 'policy' | 'flag' | 'author' | 'plugin'
}

/**
 * Official `RA5`: an override the user cannot change. Enterprise policy and
 * flag settings win outright; an author who set `disableModelInvocation` has
 * already pinned the skill to slash-command-only; plugin skills are managed
 * through /plugin.
 */
export function getSkillOverrideLock(
  command: {
    source: PromptCommand['source']
    disableModelInvocation?: boolean
  },
  name: string,
): SkillOverrideLock | undefined {
  const policy = getSettingsForSource('policySettings')?.skillOverrides?.[name]
  if (policy) return { value: policy, source: 'policy' }

  const flag = getSettingsForSource('flagSettings')?.skillOverrides?.[name]
  if (flag) return { value: flag, source: 'flag' }

  if (command.disableModelInvocation) {
    return { value: 'user-invocable-only', source: 'author' }
  }
  if (command.source === 'plugin') return { value: 'on', source: 'plugin' }

  return undefined
}

/**
 * Official `CA5`: the project/user override a local override is measured
 * against. localSettings is deliberately excluded — it is the layer the
 * Skills dialog writes.
 */
export function getSharedSkillOverride(
  name: string,
): SkillOverride | undefined {
  return (
    getSettingsForSource('projectSettings')?.skillOverrides?.[name] ??
    getSettingsForSource('userSettings')?.skillOverrides?.[name]
  )
}

/**
 * Official `na`: the effective override for a command. Plugin skills are
 * always on (managed via /plugin) and non-prompt commands have no override.
 */
export function getSkillOverride(command: Command): SkillOverride {
  if (command.type !== 'prompt' || command.source === 'plugin') return 'on'
  return getInitialSettings().skillOverrides?.[command.name] ?? 'on'
}

/** Official `yL5`: the model may not invoke this skill. */
export function isSkillHiddenFromModel(command: Command): boolean {
  const override = getSkillOverride(command)
  return override === 'user-invocable-only' || override === 'off'
}

/** Official `kw8`: the skill is hidden from the model and from /slash-commands. */
export function isSkillDisabled(command: Command): boolean {
  return getSkillOverride(command) === 'off'
}

/**
 * Official `xR5`: the model sees the name but not the description.
 *
 * The listing budget in SkillTool/prompt.ts checks the override inline. The
 * only official `xR5` call site is the REPL `skillTruncationStats` effect
 * (`zS4`), which this tree does not have.
 */
export function isSkillNameOnly(command: Command): boolean {
  return getSkillOverride(command) === 'name-only'
}
