import z from 'zod/v4'
import { PAUSE_ICON } from '../../constants/figures.js'
// Types extracted to src/types/permissions.ts to break import cycles
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../types/permissions.js'
import type { ToolPermissionContext, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { NetworkHostPattern, SandboxAskCallback } from '../sandbox/sandbox-adapter.js'
import { lazySchema } from '../lazySchema.js'
import { classifySandboxNetworkAccess } from './yoloClassifier.js'

// Re-export for backwards compatibility
export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
}

export const permissionModeSchema = lazySchema(() => z.enum(PERMISSION_MODES))
export const externalPermissionModeSchema = lazySchema(() =>
  z.enum(EXTERNAL_PERMISSION_MODES),
)

type ModeColorKey =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

const PERMISSION_MODE_CONFIG: Partial<
  Record<PermissionMode, PermissionModeConfig>
> = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  auto: {
    title: 'Auto mode',
    shortTitle: 'Auto',
    symbol: '⏵⏵',
    color: 'warning',
    external: 'auto',
  },
}

/**
 * Type guard to check if a PermissionMode is an ExternalPermissionMode.
 * bubble is internal-only.
 */
export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  return mode !== 'bubble'
}

function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return getModeConfig(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  return getModeConfig(mode).shortTitle
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}

/**
 * Auto-resolve sandbox network prompts in modes that should not show a dialog.
 * `true`/`false` is the decision; `null` means ask the user.
 *
 * Official `ZF$`/`QBH` maps `auto` to `"classify"`. This helper still maps
 * `auto` to allow — InboxPoller / REPL call it and must not be treated as
 * the 2.1.157 `nT9` wrap. Use {@link sandboxNetworkPermissionDecision} for
 * the four-way official decision.
 */
export function shouldAutoApproveSandboxNetwork(
  mode: PermissionMode,
  planBypassAvailable: boolean,
): boolean | null {
  if (
    mode === 'auto' ||
    mode === 'bypassPermissions' ||
    (mode === 'plan' && planBypassAvailable)
  ) {
    return true
  }
  if (mode === 'dontAsk') {
    return false
  }
  return null
}

/** Official 2.1.157 `QBH` (156 `ZF$` rename) — four-way sandbox-network decision. */
export type SandboxNetworkPermissionDecision =
  | 'allow'
  | 'deny'
  | 'classify'
  | 'ask'

export function sandboxNetworkPermissionDecision(
  mode: PermissionMode,
  isBypassPermissionsModeAvailable: boolean,
): SandboxNetworkPermissionDecision {
  if (mode === 'auto') return 'classify'
  if (mode === 'bypassPermissions' || (mode === 'plan' && isBypassPermissionsModeAvailable)) {
    return 'allow'
  }
  if (mode === 'dontAsk') return 'deny'
  return 'ask'
}

/**
 * Official 2.1.157 `nT9` — wrap an SDK/print sandbox ask callback with `QBH`.
 * `auto` classifies via `irH`; bypass/plan-bypass allow; dontAsk denies; else ask.
 */
export function wrapSandboxAskCallback(
  ask: SandboxAskCallback,
  getContext: () => ToolPermissionContext,
  getMessages: () => Message[],
  getTools: () => Tools,
): SandboxAskCallback {
  return async (hostPattern: NetworkHostPattern) => {
    const ctx = getContext()
    switch (
      sandboxNetworkPermissionDecision(
        ctx.mode,
        ctx.isBypassPermissionsModeAvailable,
      )
    ) {
      case 'allow':
        return true
      case 'deny':
        return false
      case 'classify':
        return classifySandboxNetworkAccess(
          hostPattern.host,
          hostPattern.port,
          getMessages(),
          getTools(),
          ctx,
          new AbortController().signal,
        )
      case 'ask':
        return ask(hostPattern)
    }
  }
}
