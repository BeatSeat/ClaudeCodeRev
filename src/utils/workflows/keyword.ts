import { logEvent } from '../../services/analytics/index.js'
import { findKeywordTriggerPositions } from '../ultraplan/keyword.js'
import { isWorkflowKeywordTriggerEnabled, isWorkflowsEnabled } from './enabled.js'

export function findWorkflowTriggerPositions(
  text: string,
): { word: string; start: number; end: number }[] {
  return findKeywordTriggerPositions(text, 'workflows?')
}

export function hasWorkflowKeyword(text: string): boolean {
  return findWorkflowTriggerPositions(text).length > 0
}

let workflowKeywordIgnored = false
const workflowKeywordIgnoredListeners = new Set<() => void>()

export function subscribeWorkflowKeywordIgnored(onStoreChange: () => void): () => void {
  workflowKeywordIgnoredListeners.add(onStoreChange)
  return () => {
    workflowKeywordIgnoredListeners.delete(onStoreChange)
  }
}

export function setWorkflowKeywordIgnored(ignored: boolean): void {
  if (workflowKeywordIgnored === ignored) return
  workflowKeywordIgnored = ignored
  for (const listener of workflowKeywordIgnoredListeners) listener()
}

export function isWorkflowKeywordIgnored(): boolean {
  return workflowKeywordIgnored
}

/** Official 2.1.157: backspace at the end of a trigger calls the same dismiss as alt+w. */
export function shouldDismissWorkflowKeywordOnBackspace(
  text: string,
  cursorOffset: number,
): boolean {
  if (!shouldHighlightWorkflowKeyword(text) || workflowKeywordIgnored) {
    return false
  }
  return findWorkflowTriggerPositions(text).some(
    trigger => trigger.end === cursorOffset,
  )
}

/** Official 2.1.157 rainbow/submit gate: workflows on + keyword setting. */
export function shouldHighlightWorkflowKeyword(text: string): boolean {
  return (
    isWorkflowsEnabled() &&
    isWorkflowKeywordTriggerEnabled() &&
    hasWorkflowKeyword(text)
  )
}

/** Official 2.1.157 `lR_`. */
export function workflowKeywordRequestAttachment(
  text: string,
): { type: 'workflow_keyword_request' }[] {
  if (!text || !hasWorkflowKeyword(text)) return []
  logEvent('tengu_workflow_keyword', {})
  return [{ type: 'workflow_keyword_request' }]
}
