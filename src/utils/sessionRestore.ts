import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { dirname } from 'path'
import {
  addSessionCronTask,
  getMainLoopModelOverride,
  getSessionCronTasks,
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setMainThreadAgentHooks,
  setOriginalCwd,
  setScheduledTasksEnabled,
  switchSession,
} from '../bootstrap/state.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from './settings/pluginOnlyPolicy.js'
import type { HooksSettings } from './settings/types.js'
import type { AppState } from '../state/AppState.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../tools/AgentTool/loadAgentsDir.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  isKairosCronEnabled,
} from '../tools/ScheduleCronTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  PersistedWorktreeSession,
} from '../types/logs.js'
import type { Message } from '../types/message.js'
import { renameRecordingForSession } from './asciicast.js'
import { clearMemoryFileCaches } from './claudemd.js'
import {
  type AttributionState,
  attributionRestoreStateFromLog,
  restoreAttributionStateFromSnapshots,
} from './commitAttribution.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { getCronJitterConfig } from './cronJitterConfig.js'
import { oneShotJitteredNextCronRunMs } from './cronTasks.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import { enqueuePendingNotification } from './messageQueueManager.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { createSystemMessage } from './messages.js'
import { parseUserSpecifiedModel } from './model/model.js'
import { getPlansDirectory } from './plans.js'
import { setCwd } from './Shell.js'
import {
  adoptResumedSessionFile,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
  saveWorktreeState,
} from './sessionStorage.js'
import { isTodoV2Enabled } from './tasks.js'
import { escapeXml } from './xml.js'
import type { TodoList } from './todo/types.js'
import { TodoListSchema } from './todo/types.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from './worktree.js'

type ResumeResult = {
  messages?: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
}

/**
 * Scan the transcript for the last TodoWrite tool_use block and return its todos.
 * Used to hydrate AppState.todos on SDK --resume so the model's todo list
 * survives session restarts without file persistence.
 */
function extractTodosFromTranscript(messages: Message[]): TodoList {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const toolUse = msg.message.content.find(
      block => block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (!toolUse || toolUse.type !== 'tool_use') continue
    const input = toolUse.input
    if (input === null || typeof input !== 'object') return []
    const parsed = TodoListSchema().safeParse(
      (input as Record<string, unknown>).todos,
    )
    return parsed.success ? parsed.data : []
  }
  return []
}

/**
 * Restore session state (file history, attribution, todos) from log on resume.
 * Used by both SDK (print.ts) and interactive (REPL.tsx, main.tsx) resume paths.
 */
export function restoreSessionStateFromLog(
  result: ResumeResult,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  // Restore file history state
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
      setAppState(prev => ({ ...prev, fileHistory: newState }))
    })
  }

  // Restore attribution state (ant-only feature)
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    attributionRestoreStateFromLog(result.attributionSnapshots, newState => {
      setAppState(prev => ({ ...prev, attribution: newState }))
    })
  }

  // Restore context-collapse commit log + staged snapshot. Must run before
  // the first query() so projectView() can rebuild the collapsed view from
  // the resumed Message[]. Called unconditionally (even with
  // undefined/empty entries) because restoreFromEntries resets the store
  // first — without that, an in-session /resume into a session with no
  // commits would leave the prior session's stale commit log intact.
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      result.contextCollapseCommits ?? [],
      result.contextCollapseSnapshot,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // Restore TodoWrite state from transcript (SDK/non-interactive only).
  // Interactive mode uses file-backed v2 tasks, so AppState.todos is unused there.
  if (!isTodoV2Enabled() && result.messages && result.messages.length > 0) {
    const todos = extractTodosFromTranscript(result.messages)
    if (todos.length > 0) {
      const agentId = getSessionId()
      setAppState(prev => ({
        ...prev,
        todos: { ...prev.todos, [agentId]: todos },
      }))
    }
  }
}

/**
 * Compute restored attribution state from log snapshots.
 * Used for computing initial state before render (e.g., main.tsx --continue).
 * Returns undefined if attribution feature is disabled or no snapshots exist.
 */
export function computeRestoredAttributionState(
  result: ResumeResult,
): AttributionState | undefined {
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    return restoreAttributionStateFromSnapshots(result.attributionSnapshots)
  }
  return undefined
}

/**
 * Compute standalone agent context (name/color) for session resume.
 * Used for computing initial state before render (per CLAUDE.md guidelines).
 * Returns undefined if no name/color is set on the session.
 */
export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): AppState['standaloneAgentContext'] | undefined {
  if (!agentName && !agentColor) {
    return undefined
  }
  return {
    name: agentName ?? '',
    color: (agentColor === 'default' ? undefined : agentColor) as
      | AgentColorName
      | undefined,
  }
}

/**
 * Official 2.1.116 rAH: store main-thread --agent frontmatter hooks so
 * getHooksConfig fires them (subagent registerFrontmatterHooks is a
 * different path — isAgent=true remaps Stop→SubagentStop).
 */
export function applyMainThreadAgentHooks(
  agent:
    | { hooks?: HooksSettings; source?: string }
    | undefined,
): void {
  if (
    agent?.hooks &&
    (!isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(agent.source))
  ) {
    setMainThreadAgentHooks(agent.hooks)
  } else {
    setMainThreadAgentHooks(undefined)
  }
}

/**
 * Restore agent setting from a resumed session.
 *
 * When resuming a conversation that used a custom agent, this re-applies the
 * agent type and model override (unless the user specified --agent on the CLI).
 * Mutates bootstrap state via setMainThreadAgentType / setMainLoopModelOverride.
 *
 * Returns the restored agent definition and its agentType string, or undefined
 * if no agent was restored.
 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): {
  agentDefinition: AgentDefinition | undefined
  agentType: string | undefined
} {
  // If user already specified --agent on CLI, keep that definition
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }

  // If session had no agent, clear any stale bootstrap state
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    applyMainThreadAgentHooks(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  const resumedAgent = agentDefinitions.activeAgents.find(
    agent => agent.agentType === agentSetting,
  )
  if (!resumedAgent) {
    logForDebugging(
      `Resumed session had agent "${agentSetting}" but it is no longer available. Using default behavior.`,
    )
    setMainThreadAgentType(undefined)
    applyMainThreadAgentHooks(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  setMainThreadAgentType(resumedAgent.agentType)
  applyMainThreadAgentHooks(resumedAgent)

  // Apply agent's model if user didn't specify one
  if (
    !getMainLoopModelOverride() &&
    resumedAgent.model &&
    resumedAgent.model !== 'inherit'
  ) {
    setMainLoopModelOverride(parseUserSpecifiedModel(resumedAgent.model))
  }

  return { agentDefinition: resumedAgent, agentType: resumedAgent.agentType }
}

/**
 * Refresh agent definitions after a coordinator/normal mode switch.
 *
 * When resuming a session that was in a different mode (coordinator vs normal),
 * the built-in agents need to be re-derived to match the new mode. CLI-provided
 * agents (from --agents flag) are merged back in.
 */
export async function refreshAgentDefinitionsForModeSwitch(
  modeWasSwitched: boolean,
  currentCwd: string,
  cliAgents: AgentDefinition[],
  currentAgentDefinitions: AgentDefinitionsResult,
): Promise<AgentDefinitionsResult> {
  if (!feature('COORDINATOR_MODE') || !modeWasSwitched) {
    return currentAgentDefinitions
  }

  // Re-derive agent definitions after mode switch so built-in agents
  // reflect the new coordinator/normal mode
  getAgentDefinitionsWithOverrides.cache.clear?.()
  const freshAgentDefs = await getAgentDefinitionsWithOverrides(currentCwd)
  const freshAllAgents = [...freshAgentDefs.allAgents, ...cliAgents]
  return {
    ...freshAgentDefs,
    allAgents: freshAllAgents,
    activeAgents: getActiveAgentsFromList(freshAllAgents),
  }
}

/**
 * Result of processing a resumed/continued conversation for rendering.
 */
export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}

/**
 * Subset of the coordinator mode module API needed for session resume.
 */
type CoordinatorModeApi = {
  matchSessionMode(mode?: string): string | undefined
  isCoordinatorMode(): boolean
}

/**
 * The loaded conversation data (return type of loadConversationForResume).
 */
type ResumeLoadResult = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/**
 * Restore the worktree working directory on resume. The transcript records
 * the last worktree enter/exit; if the session crashed while inside a
 * worktree (last entry = session object, not null), cd back into it.
 *
 * process.chdir is the TOCTOU-safe existence check — it throws ENOENT if
 * the /exit dialog removed the directory, or if the user deleted it
 * manually between sessions.
 *
 * When --worktree already created a fresh worktree, that takes precedence
 * over the resumed session's state. restoreSessionMetadata just overwrote
 * project.currentSessionWorktree with the stale transcript value, so
 * re-assert the fresh worktree here before adoptResumedSessionFile writes
 * it back to disk.
 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const fresh = getCurrentWorktreeSession()
  if (fresh) {
    saveWorktreeState(fresh)
    return
  }
  if (!worktreeSession) return

  try {
    process.chdir(worktreeSession.worktreePath)
  } catch {
    // Directory is gone. Override the stale cache so the next
    // reAppendSessionMetadata records "exited" instead of re-persisting
    // a path that no longer exists.
    saveWorktreeState(null)
    return
  }

  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())
  // projectRoot is intentionally NOT set here. The transcript doesn't record
  // whether the worktree was entered via --worktree (which sets projectRoot)
  // or EnterWorktreeTool (which doesn't). Leaving projectRoot stable matches
  // EnterWorktreeTool's behavior — skills/history stay anchored to the
  // original project.
  restoreWorktreeSession(worktreeSession)
  // The /resume slash command calls this mid-session after caches have been
  // populated against the old cwd. Cheap no-ops for the CLI-flag path
  // (caches aren't populated yet there).
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
}

/**
 * Undo restoreWorktreeForResume before a mid-session /resume switches to
 * another session. Without this, /resume from a worktree session to a
 * non-worktree session leaves the user in the old worktree directory with
 * currentWorktreeSession still pointing at the prior session. /resume to a
 * *different* worktree fails entirely — the getCurrentWorktreeSession()
 * guard above blocks the switch.
 *
 * Not needed by CLI --resume/--continue: those run once at startup where
 * getCurrentWorktreeSession() is only truthy if --worktree was used (fresh
 * worktree that should take precedence, handled by the re-assert above).
 */
export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (!current) return

  restoreWorktreeSession(null)
  // Worktree state changed, so cached prompt sections that reference it are
  // stale whether or not chdir succeeds below.
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()

  try {
    process.chdir(current.originalCwd)
  } catch {
    // Original dir is gone (rare). Stay put — restoreWorktreeForResume
    // will cd into the target worktree next if there is one.
    return
  }
  setCwd(current.originalCwd)
  setOriginalCwd(getCwd())
}

/**
 * Process a loaded conversation for resume/continue.
 *
 * Handles coordinator mode matching, session ID setup, agent restoration,
 * mode persistence, and initial state computation. Called by both --continue
 * and --resume paths in main.tsx.
 */
export async function processResumedConversation(
  result: ResumeLoadResult,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    modeApi: CoordinatorModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  // Match coordinator/normal mode to the resumed session
  let modeWarning: string | undefined
  if (feature('COORDINATOR_MODE')) {
    modeWarning = context.modeApi?.matchSessionMode(result.mode)
    if (modeWarning) {
      result.messages.push(createSystemMessage(modeWarning, 'warning'))
    }
  }

  // Reuse the resumed session's ID unless --fork-session is specified
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    if (sid) {
      // When resuming from a different project directory (git worktrees,
      // cross-project), transcriptPath points to the actual file; its dirname
      // is the project dir. Otherwise the session lives in the current project.
      switchSession(
        asSessionId(sid),
        opts.transcriptPath ? dirname(opts.transcriptPath) : null,
      )
      // Rename asciicast recording to match the resumed session ID so
      // getSessionRecordingPaths() can discover it during /share
      await renameRecordingForSession()
      await resetSessionFilePointer()
      restoreCostStateForSession(sid)
    }
  } else if (result.contentReplacements?.length) {
    // --fork-session keeps the fresh startup session ID. useLogMessages will
    // copy source messages into the new JSONL via recordTranscript, but
    // content-replacement entries are a separate entry type only written by
    // recordContentReplacement (which query.ts calls for newlyReplaced, never
    // the pre-loaded records). Without this seed, `claude -r {newSessionId}`
    // finds source tool_use_ids in messages but no matching replacement records
    // → they're classified as FROZEN → full content sent (cache miss, permanent
    // overage). insertContentReplacement stamps sessionId = getSessionId() =
    // the fresh ID, so loadTranscriptFile's keyed lookup will match.
    await recordContentReplacement(result.contentReplacements)
  }

  // Restore session metadata so /status shows the saved name and metadata
  // is re-appended on session exit. Fork doesn't take ownership of the
  // original session's worktree — a "Remove" on the fork's exit dialog
  // would delete a worktree the original session still references — so
  // strip worktreeSession from the fork path so the cache stays unset.
  restoreSessionMetadata(
    opts.forkSession ? { ...result, worktreeSession: undefined } : result,
  )

  if (!opts.forkSession) {
    // Cd back into the worktree the session was in when it last exited.
    // Done after restoreSessionMetadata (which caches the worktree state
    // from the transcript) so if the directory is gone we can override
    // the cache before adoptResumedSessionFile writes it.
    restoreWorktreeForResume(result.worktreeSession)

    // Point sessionFile at the resumed transcript and re-append metadata
    // now. resetSessionFilePointer above nulled it (so the old fresh-session
    // path doesn't leak), but that blocks reAppendSessionMetadata — which
    // bails on null — from running in the exit cleanup handler. For fork,
    // useLogMessages populates a *new* file via recordTranscript on REPL
    // mount; the normal lazy-materialize path is correct there.
    adoptResumedSessionFile()
  }

  // Restore context-collapse commit log + staged snapshot. The interactive
  // /resume path goes through restoreSessionStateFromLog (REPL.tsx); CLI
  // --continue/--resume goes through here instead. Called unconditionally
  // — see the restoreSessionStateFromLog callsite above for why.
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      result.contextCollapseCommits ?? [],
      result.contextCollapseSnapshot,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // Restore agent setting from resumed session
  const { agentDefinition: restoredAgent, agentType: resumedAgentType } =
    restoreAgentFromSession(
      result.agentSetting,
      context.mainThreadAgentDefinition,
      context.agentDefinitions,
    )

  // Persist the current mode so future resumes know what mode this session was in
  if (feature('COORDINATOR_MODE')) {
    saveMode(context.modeApi?.isCoordinatorMode() ? 'coordinator' : 'normal')
  }

  // Compute initial state before render (per CLAUDE.md guidelines)
  const restoredAttribution = opts.includeAttribution
    ? computeRestoredAttributionState(result)
    : undefined
  const standaloneAgentContext = computeStandaloneAgentContext(
    result.agentName,
    result.agentColor,
  )
  void updateSessionName(result.agentName)
  const refreshedAgentDefs = await refreshAgentDefinitionsForModeSwitch(
    !!modeWarning,
    context.currentCwd,
    context.cliAgents,
    context.agentDefinitions,
  )

  return {
    messages: result.messages,
    fileHistorySnapshots: result.fileHistorySnapshots,
    contentReplacements: result.contentReplacements,
    agentName: result.agentName,
    agentColor: (result.agentColor === 'default'
      ? undefined
      : result.agentColor) as AgentColorName | undefined,
    restoredAgentDef: restoredAgent,
    initialState: {
      ...context.initialState,
      ...(resumedAgentType && { agent: resumedAgentType }),
      ...(restoredAttribution && { attribution: restoredAttribution }),
      ...(standaloneAgentContext && { standaloneAgentContext }),
      agentDefinitions: refreshedAgentDefs,
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type ExtractedAsyncAgent = {
  agentId: string
  description: string
  outputFile?: string
}

type ExtractedCronCalls = {
  calls: Array<{
    toolUseId: string
    input: Record<string, unknown>
    createdAt: number
  }>
  results: Map<string, Record<string, unknown>>
  deletedCronIds: Set<string>
  asyncAgents: Map<string, ExtractedAsyncAgent>
  notifiedTaskIds: Set<string>
}

const TASK_NOTIFICATION_OPEN = `<${TASK_NOTIFICATION_TAG}>`
const TASK_ID_RE = new RegExp(
  `<${TASK_ID_TAG}>([^<]+)</${TASK_ID_TAG}>`,
  'g',
)

function messageContentToText(
  content: string | Array<{ type?: string; text?: string }>,
): string {
  if (typeof content === 'string') return content
  return content
    .map(block =>
      typeof block === 'object' && block && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('\n')
}

/** Official 2.1.157 `fX9` — collect `<task-id>` from task-notification XML. */
function collectNotifiedTaskIds(text: string, into: Set<string>): void {
  if (!text.includes(TASK_NOTIFICATION_OPEN)) return
  for (const match of text.matchAll(TASK_ID_RE)) {
    if (match[1]) into.add(match[1])
  }
}

/**
 * Official 2.1.157 `TCz` — scan a resumed transcript for session-only
 * CronCreate/CronDelete tool_use and async_launched background agents.
 */
function extractSessionCronCalls(messages: Message[]): ExtractedCronCalls {
  const calls: ExtractedCronCalls['calls'] = []
  const results = new Map<string, Record<string, unknown>>()
  const deletedCronIds = new Set<string>()
  const asyncAgents = new Map<string, ExtractedAsyncAgent>()
  const notifiedTaskIds = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const content = msg.message.content
      if (!Array.isArray(content)) continue
      const createdAt = Date.parse(msg.timestamp)
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const input = isPlainObject(block.input) ? block.input : {}
        if (block.name === CRON_CREATE_TOOL_NAME) {
          calls.push({ toolUseId: block.id, input, createdAt })
        } else if (block.name === CRON_DELETE_TOOL_NAME) {
          if (typeof input.id === 'string') deletedCronIds.add(input.id)
        }
      }
    } else if (msg.type === 'user') {
      collectNotifiedTaskIds(
        messageContentToText(msg.message.content),
        notifiedTaskIds,
      )
      const content = msg.message.content
      if (!Array.isArray(content)) continue
      const toolUseResult = msg.toolUseResult
      if (!isPlainObject(toolUseResult)) continue
      for (const block of content) {
        if (block.type === 'tool_result' && !block.is_error) {
          results.set(block.tool_use_id, toolUseResult)
        }
      }
      if (
        toolUseResult.status === 'async_launched' &&
        typeof toolUseResult.agentId === 'string' &&
        typeof toolUseResult.description === 'string'
      ) {
        asyncAgents.set(toolUseResult.agentId, {
          agentId: toolUseResult.agentId,
          description: toolUseResult.description,
          outputFile:
            typeof toolUseResult.outputFile === 'string'
              ? toolUseResult.outputFile
              : undefined,
        })
      }
    } else if (
      msg.type === 'attachment' &&
      msg.attachment.type === 'queued_command' &&
      typeof msg.attachment.prompt === 'string'
    ) {
      collectNotifiedTaskIds(msg.attachment.prompt, notifiedTaskIds)
    }
  }
  return { calls, results, deletedCronIds, asyncAgents, notifiedTaskIds }
}

/**
 * Official 2.1.110 G_A — restore unexpired session-only cron tasks into
 * bootstrap state. Durable jobs are already on disk; skip those.
 */
function applyExtractedSessionCronTasks({
  calls,
  results,
  deletedCronIds,
}: ExtractedCronCalls): void {
  if (!isKairosCronEnabled()) return
  const nowMs = Date.now()
  const jitter = getCronJitterConfig()
  const existing = new Set(getSessionCronTasks().map(t => t.id))
  let restored = 0
  for (const call of calls) {
    const result = results.get(call.toolUseId)
    if (!result || typeof result.id !== 'string') continue
    if (result.durable === true) continue
    if (deletedCronIds.has(result.id) || existing.has(result.id)) continue
    const cron = call.input.cron
    const prompt = call.input.prompt
    if (typeof cron !== 'string' || typeof prompt !== 'string') continue
    const recurring = result.recurring !== false
    if (recurring) {
      if (
        jitter.recurringMaxAgeMs !== 0 &&
        nowMs - call.createdAt >= jitter.recurringMaxAgeMs
      ) {
        continue
      }
    } else {
      const next = oneShotJitteredNextCronRunMs(
        cron,
        call.createdAt,
        result.id,
        jitter,
      )
      if (next === null || next < nowMs) continue
    }
    addSessionCronTask({
      id: result.id,
      cron,
      prompt,
      createdAt: call.createdAt,
      recurring,
    })
    restored++
  }
  if (restored > 0) {
    setScheduledTasksEnabled(true)
    logForDebugging(`resume: resurrected ${restored} session cron task(s)`)
  }
}

/**
 * Official 2.1.157 `vCz` — notify that in-process background agents were
 * orphaned when the previous Claude Code process exited.
 */
function notifyOrphanedBackgroundAgents(
  { asyncAgents, notifiedTaskIds }: ExtractedCronCalls,
  liveTasks?: Record<string, unknown>,
): void {
  let orphaned = 0
  for (const agent of asyncAgents.values()) {
    if (notifiedTaskIds.has(agent.agentId) || liveTasks?.[agent.agentId]) {
      continue
    }
    orphaned++
    const outputFile = agent.outputFile
      ? `\n<${OUTPUT_FILE_TAG}>${escapeXml(agent.outputFile)}</${OUTPUT_FILE_TAG}>`
      : ''
    enqueuePendingNotification({
      value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${escapeXml(agent.agentId)}</${TASK_ID_TAG}>${outputFile}
<${STATUS_TAG}>failed</${STATUS_TAG}>
<${SUMMARY_TAG}>Background agent "${escapeXml(agent.description)}" was running when the previous Claude Code process exited and did not complete. Its in-process state was lost. Check its worktree/output for partial work before assuming the task landed.</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`,
      mode: 'task-notification',
      priority: 'next',
    })
  }
  if (orphaned > 0) {
    logEvent('tengu_feature_sad', {
      feature_name:
        'task_local_agent' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_code:
        'orphaned_on_resume' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logForDebugging(
      `resume: ${orphaned} background agent(s) orphaned by previous process exit`,
    )
  }
}

/**
 * Official 2.1.157 `D_q` — --resume/--continue resurrects unexpired
 * session-only scheduled tasks and reports orphaned background subagents.
 */
export function resurrectSessionCronTasks(
  messages: Message[],
  liveTasks?: Record<string, unknown>,
): void {
  try {
    const extracted = extractSessionCronCalls(messages)
    applyExtractedSessionCronTasks(extracted)
    notifyOrphanedBackgroundAgents(extracted, liveTasks)
  } catch (err) {
    logError(err)
  }
}
