import type { AppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../Tool.js'

type AlwaysDenyMode = 'replace' | 'union'

/**
 * Official 2.1.152 `JW8`.
 * `setToolPermissionContext` updater: merge (`union`) or replace
 * `alwaysDenyRules.command`. No-op when the list is unchanged.
 */
export function applyAlwaysDenyCommandRules(
  setToolPermissionContext: (
    updater: (prev: ToolPermissionContext) => ToolPermissionContext,
  ) => void,
  tools: string[],
  mode: AlwaysDenyMode = 'replace',
): void {
  setToolPermissionContext(prev => {
    const existing = prev.alwaysDenyRules.command
    const next =
      mode === 'union'
        ? [...new Set([...(existing ?? []), ...tools])]
        : [...tools]
    if (
      (existing?.length ?? 0) === next.length &&
      (existing ?? []).every((value, index) => value === next[index])
    ) {
      return prev
    }
    return {
      ...prev,
      alwaysDenyRules: {
        ...prev.alwaysDenyRules,
        command: next.length > 0 ? next : undefined,
      },
    }
  })
}

/**
 * Official REPL `setToolPermissionContext` is a setAppState wrapper that
 * accepts an updater. This tree's ToolUseContext only exposes setAppState.
 */
export function applyAlwaysDenyCommandRulesFromContext(
  context: {
    setAppState: (f: (prev: AppState) => AppState) => void
  },
  tools: string[],
  mode: AlwaysDenyMode = 'replace',
): void {
  applyAlwaysDenyCommandRules(
    updater => {
      context.setAppState(prev => {
        const next = updater(prev.toolPermissionContext)
        if (next === prev.toolPermissionContext) {
          return prev
        }
        return { ...prev, toolPermissionContext: next }
      })
    },
    tools,
    mode,
  )
}
