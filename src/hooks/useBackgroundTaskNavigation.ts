import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'

/**
 * Official 2.1.179 `ZU9`: viewing-agent Escape aborts running teammate work
 * or exits the view. Selecting-agent / shift+↑↓ teammate tree navigation was
 * DCE'd with `selecting-agent` / TeammateSpinnerTree (`YZz` / `uB9` / `Px8`).
 */
export function useBackgroundTaskNavigation(_options?: {
  onOpenBackgroundTasks?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (isInProcessTeammateTask(task) && task.status === 'running') {
          task.currentWorkAbortController?.abort()
          return
        }
      }
      exitTeammateView(setAppState)
    }
  }

  // Backward-compat bridge: REPL.tsx doesn't yet wire handleKeyDown to
  // <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until the consumer is migrated (separate PR).
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
