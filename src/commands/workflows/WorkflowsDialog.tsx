import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getProjectRoot } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import TextInput from '../../components/TextInput.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  killWorkflowTask,
  type LocalWorkflowTaskState,
  type WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { count } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import {
  listWorkflows,
  parseWorkflowScript,
} from '../../tools/WorkflowTool/WorkflowTool.js'
import {
  loadWorkflowHistory,
  type WorkflowSnapshot,
} from '../../tools/WorkflowTool/runtime.js'

type HistoryTask = {
  id: string
  type: 'local_workflow'
  description: string
  status: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  script: string
  scriptPath?: string
  summary?: string
  workflowName?: string
  title?: string
  phases?: LocalWorkflowTaskState['phases']
  defaultModel?: string
  workflowRunId?: string
  workflowProgress: WorkflowProgressEvent[]
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  logs: string[]
  result?: unknown
  error?: string
}

type HistoryItem = {
  task: HistoryTask
  snapshot?: WorkflowSnapshot
}

type ViewState =
  | { mode: 'list' }
  | { mode: 'detail'; itemId: string }
  | { mode: 'save'; itemId: string }

type PhaseRow = {
  title: string
  status: 'done' | 'failed' | 'running' | 'not-started'
  agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[]
  doneCount: number
  totalCount: number
}

/** Official 2.1.153 `u9H`. */
function slugWorkflowName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow'
  )
}

/** Official 2.1.153 `gOz`. */
function isLocalWorkflowTask(task: unknown): task is HistoryTask {
  return (
    !!task &&
    typeof task === 'object' &&
    'type' in task &&
    (task as { type: unknown }).type === 'local_workflow'
  )
}

/** Official 2.1.153 `QOz`. */
function workflowRunIdOf(task: HistoryTask): string | undefined {
  return task.workflowRunId
}

/** Official 2.1.153 `FOz`. */
function isPresent<T>(value: T): value is NonNullable<T> {
  return !!value
}

/** Official 2.1.153 `pOz`. */
function asLiveItem(task: HistoryTask): HistoryItem {
  return { task }
}

/** Official 2.1.153 `xOz`. */
function snapshotToTask(snapshot: WorkflowSnapshot): HistoryTask {
  return {
    id: snapshot.taskId,
    type: 'local_workflow',
    description: snapshot.summary ?? 'Dynamic workflow',
    status: snapshot.status,
    startTime: snapshot.startTime,
    endTime: snapshot.startTime + snapshot.durationMs,
    script: snapshot.script,
    scriptPath: snapshot.scriptPath,
    summary: snapshot.summary,
    workflowName: snapshot.workflowName,
    phases: snapshot.phases,
    defaultModel: snapshot.defaultModel,
    workflowRunId: snapshot.runId,
    workflowProgress: snapshot.workflowProgress,
    agentCount: snapshot.agentCount,
    totalTokens: snapshot.totalTokens ?? 0,
    totalToolCalls: snapshot.totalToolCalls ?? 0,
    logs: snapshot.logs,
    result: snapshot.result,
    error: snapshot.error,
  }
}

/** Official 2.1.153 `UOz`. */
function asSnapshotItem(snapshot: WorkflowSnapshot): HistoryItem {
  return { task: snapshotToTask(snapshot), snapshot }
}

/** Official 2.1.153 `BOz`. */
function compareHistoryItems(a: HistoryItem, b: HistoryItem): number {
  return b.task.startTime - a.task.startTime
}

/** Official 2.1.153 `uOz`. */
function isRunningItem(item: HistoryItem): boolean {
  return item.task.status === 'running'
}

/** Official 2.1.153 `mOz`. */
function decrementIndex(index: number): number {
  return Math.max(0, index - 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Official 2.1.153 `lP8`. */
function collectProgress(events: WorkflowProgressEvent[]): {
  agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[]
  logs: string[]
  phaseTitles: Map<number, { title?: string; kind?: string }>
} {
  const agents = new Map<
    number,
    Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>
  >()
  const logs: string[] = []
  const phaseTitles = new Map<number, { title?: string; kind?: string }>()
  for (const event of events) {
    if (event.type === 'workflow_agent') {
      agents.set(event.index, event)
    } else if (event.type === 'workflow_log') {
      logs.push(event.message)
    } else if (event.type === 'workflow_phase') {
      phaseTitles.set(event.index, { title: event.title, kind: event.kind })
    }
  }
  return {
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    logs,
    phaseTitles,
  }
}

/** Official 2.1.153 `nB6`. */
function groupAgentsByPhase(
  agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[],
  phaseTitles: Map<number, { title?: string; kind?: string }>,
): Array<{
  phaseIndex: number
  title: string
  kind?: string
  agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[]
}> | null {
  if (!agents.some(agent => agent.phaseIndex != null)) {
    return null
  }
  const groups = new Map<
    number,
    {
      phaseIndex: number
      title: string
      kind?: string
      agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[]
    }
  >()
  for (const agent of agents) {
    const phaseIndex = agent.phaseIndex ?? 0
    let group = groups.get(phaseIndex)
    if (!group) {
      const meta = phaseTitles.get(phaseIndex)
      group = {
        phaseIndex,
        title: meta?.title ?? `Phase ${phaseIndex}`,
        kind: meta?.kind,
        agents: [],
      }
      groups.set(phaseIndex, group)
    }
    group.agents.push(agent)
  }
  return [...groups.values()].sort((a, b) => a.phaseIndex - b.phaseIndex)
}

/** Official 2.1.153 `aB6`. */
function phaseFromAgents(group: {
  title: string
  agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[]
}): PhaseRow {
  const doneCount = count(group.agents, agent => agent.state === 'done')
  const failedCount = count(group.agents, agent => agent.state === 'error')
  const totalCount = group.agents.length
  const finished = doneCount + failedCount === totalCount && totalCount > 0
  return {
    title: group.title,
    status: finished ? (failedCount > 0 ? 'failed' : 'done') : 'running',
    agents: group.agents,
    doneCount,
    totalCount,
  }
}

/** Official 2.1.153 `EZ_`. */
function emptyPhase(title: string): PhaseRow {
  return {
    title,
    status: 'not-started',
    agents: [],
    doneCount: 0,
    totalCount: 0,
  }
}

function normalizePhaseTitle(title: string): string {
  return title.toLowerCase().trim()
}

/** Official 2.1.153 `yZ_`. */
function mergePhases(
  declared: LocalWorkflowTaskState['phases'],
  grouped: Array<{
    title: string
    agents: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>[]
  }>,
): PhaseRow[] {
  const used = new Set<(typeof grouped)[number]>()
  const rows: PhaseRow[] = []
  function match(title: string) {
    const needle = normalizePhaseTitle(title)
    for (const group of grouped) {
      if (used.has(group)) {
        continue
      }
      const hay = normalizePhaseTitle(group.title)
      if (needle === hay || hay.startsWith(needle) || needle.startsWith(hay)) {
        used.add(group)
        return group
      }
    }
    return undefined
  }
  for (const phase of declared ?? []) {
    const found = match(phase.title)
    rows.push(found ? phaseFromAgents(found) : emptyPhase(phase.title))
  }
  for (const group of grouped) {
    if (!used.has(group)) {
      rows.push(phaseFromAgents(group))
    }
  }
  return rows
}

/** Official 2.1.153 `j74`. */
function buildPhaseRows(task: HistoryTask): PhaseRow[] {
  const collected = collectProgress(task.workflowProgress)
  const grouped = groupAgentsByPhase(collected.agents, collected.phaseTitles) ?? []
  const rows = mergePhases(task.phases, grouped)
  if (rows.length === 0 && collected.agents.length > 0) {
    return [phaseFromAgents({ title: 'Agents', agents: collected.agents })]
  }
  return rows
}

/** Official 2.1.153 `w74`. */
function countAgents(
  phases: PhaseRow[],
  agentCount: number,
): { doneAgents: number; totalAgents: number } {
  let doneAgents = 0
  let totalAgents = 0
  for (const phase of phases) {
    doneAgents += phase.doneCount
    totalAgents += phase.totalCount
  }
  return {
    doneAgents,
    totalAgents: Math.max(agentCount, totalAgents, doneAgents),
  }
}

/** Official 2.1.153 `D74`. */
function workflowSubtext(task: HistoryTask): string {
  if (task.script.length > 0) {
    const parsed = parseWorkflowScript(task.script)
    if (!('error' in parsed) && parsed.meta.description) {
      return parsed.meta.description
    }
  }
  return task.description || task.summary || ''
}

/** Official 2.1.153 `J74`. */
function workflowHeader(
  task: HistoryTask,
  subtext: string,
  agents: { doneAgents: number; totalAgents: number },
  durationMs: number,
): { name: string; subtext: string; stats: string } {
  const suffix =
    task.status === 'completed'
      ? ' · done'
      : task.status === 'killed'
        ? ' · stopped'
        : task.status === 'paused'
          ? ' · paused'
          : task.status === 'failed'
            ? ' · failed'
            : ''
  return {
    name: task.workflowName ?? task.summary ?? task.description,
    subtext,
    stats: `${agents.doneAgents}/${agents.totalAgents} ${plural(agents.totalAgents, 'agent')} · ${formatDuration(durationMs)}${suffix}`,
  }
}

/** Official 2.1.153 `x7z`. */
function workflowSaveDir(scope: 'project' | 'user', cwd: string): string {
  if (scope === 'user') {
    return join(getClaudeConfigHomeDir(), 'workflows')
  }
  return join(getProjectRoot() || cwd, '.claude', 'workflows')
}

/** Official 2.1.153 `yU4`. */
async function saveDynamicWorkflow({
  name,
  scope,
  script,
  overwrite,
  cwd,
}: {
  name: string
  scope: 'project' | 'user'
  script: string
  overwrite: boolean
  cwd: string
}): Promise<{ name: string; path: string; scope: 'project' | 'user' }> {
  const slug = slugWorkflowName(name)
  const dir = workflowSaveDir(scope, cwd)
  const path = join(dir, `${slug}.js`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, script, {
      encoding: 'utf8',
      mode: 0o600,
      flag: overwrite ? 'w' : 'wx',
    })
  } catch (error) {
    if (getErrnoCode(error) === 'EEXIST') {
      throw new Error(
        `Dynamic workflow "${slug}" already exists at ${path}. Use a different name or overwrite.`,
      )
    }
    throw error
  }
  listWorkflows.cache.clear?.()
  const { clearCommandMemoizationCaches } = await import('../../commands.js')
  clearCommandMemoizationCaches()
  resetSentSkillNames()
  logEvent('tengu_workflow_saved', {
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    overwrite,
    script_size_chars: script.length,
  })
  return { name: slug, path, scope }
}

function HistoryRow({
  item,
  isSelected,
}: {
  item: HistoryItem
  isSelected: boolean
}): React.ReactNode {
  const task = item.task
  const snapshot = item.snapshot
  let glyph: string
  let color: 'success' | 'error' | undefined
  switch (task.status) {
    case 'completed':
      glyph = figures.tick
      color = 'success'
      break
    case 'failed':
    case 'killed':
      glyph = figures.cross
      color = 'error'
      break
    default:
      glyph = '\u27F3'
      color = undefined
  }
  const tokens = snapshot?.totalTokens ?? task.totalTokens ?? 0
  const end = task.endTime ?? Date.now()
  const durationMs = Math.max(0, end - task.startTime - (task.totalPausedMs ?? 0))
  const parts = [
    task.agentCount > 0 ? `${task.agentCount} ${plural(task.agentCount, 'agent')}` : null,
    tokens > 0 ? `${formatTokens(tokens)} tok` : null,
    formatDuration(durationMs),
  ].filter(Boolean)
  const raw = task.workflowName ?? task.summary ?? task.description
  const label = raw.length > 50 ? `${raw.slice(0, 49)}\u2026` : raw
  const pointer = isSelected ? `${figures.pointer} ` : '  '
  return (
    <Box>
      <Text>{pointer}</Text>
      <Text color={isSelected ? 'suggestion' : undefined}>
        <Text color={color}>{glyph}</Text> {label}
        <Text dimColor>
          {'  '}
          {parts.join(' \u00b7 ')}
        </Text>
      </Text>
    </Box>
  )
}

function WorkflowDetail({
  item,
  onBack,
  onKill,
}: {
  item: HistoryItem
  onBack: () => void
  onKill?: () => void
}): React.ReactNode {
  const task = item.task
  const phases = useMemo(() => buildPhaseRows(task), [task])
  const agents = useMemo(
    () => countAgents(phases, task.agentCount),
    [phases, task.agentCount],
  )
  const durationMs = Math.max(
    0,
    (task.endTime ?? Date.now()) - task.startTime - (task.totalPausedMs ?? 0),
  )
  const header = workflowHeader(task, workflowSubtext(task), agents, durationMs)
  const running = task.status === 'running'

  useRegisterOverlay('workflow-detail-dialog')

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    return (
      <Byline>
        {running && onKill ? (
          <KeyboardShortcutHint chord="x" action="stop" />
        ) : null}
        <KeyboardShortcutHint chord="escape" action="back" />
      </Byline>
    )
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={(event: KeyboardEvent) => {
        if (event.ctrl || event.meta) {
          return
        }
        if (event.key === 'x' && running && onKill) {
          event.preventDefault()
          onKill()
        }
      }}
    >
      <Dialog
        title={header.name}
        subtitle={
          <Text dimColor>
            {header.subtext}
            {header.subtext && header.stats ? '  ' : ''}
            {header.stats}
          </Text>
        }
        onCancel={onBack}
        color="text"
        inputGuide={renderInputGuide}
      >
        {phases.length === 0 ? (
          <Text>No agents yet.</Text>
        ) : (
          <Box flexDirection="column">
            {phases.map((phase, index) => {
              const glyph =
                phase.status === 'done'
                  ? figures.tick
                  : phase.status === 'failed'
                    ? figures.cross
                    : String(index + 1)
              const counts =
                phase.totalCount > 0
                  ? `${phase.doneCount}/${phase.totalCount}`
                  : ''
              return (
                <Text
                  key={`${index}-${phase.title}`}
                  color={
                    phase.status === 'done'
                      ? 'success'
                      : phase.status === 'failed'
                        ? 'error'
                        : undefined
                  }
                  dimColor={
                    phase.status === 'not-started' || phase.status === 'running'
                  }
                >
                  {' '}
                  {glyph} {phase.title}
                  {counts ? ` ${counts}` : ''}
                </Text>
              )
            })}
          </Box>
        )}
      </Dialog>
    </Box>
  )
}

function SaveWorkflowDialog({
  script,
  defaultName,
  onDone,
}: {
  script: string
  defaultName: string
  onDone: (message?: string) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [name, setName] = useState(defaultName)
  const [cursorOffset, setCursorOffset] = useState(defaultName.length)
  const [scope, setScope] = useState<'project' | 'user'>('project')
  const [saving, setSaving] = useState(false)
  const [existingPath, setExistingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const clearStatus = () => {
    setExistingPath(null)
    setError(null)
  }

  const submit = () => {
    if (saving) {
      return
    }
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }
    setSaving(true)
    setError(null)
    void saveDynamicWorkflow({
      name: trimmed,
      scope,
      script,
      overwrite: existingPath !== null,
      cwd: getCwd(),
    })
      .then(saved => {
        onDone(
          `Dynamic workflow saved to ${saved.path}. Invoke as /${saved.name} or Workflow({name: "${saved.name}"}) in future sessions.`,
        )
      })
      .catch(caught => {
        const message = caught instanceof Error ? caught.message : String(caught)
        if (message.includes('already exists')) {
          const match = message.match(/at (.+?)\. /)
          setExistingPath(match?.[1] ?? '(unknown path)')
        } else {
          setError(message)
        }
        setSaving(false)
      })
  }

  useKeybinding('confirm:no', () => onDone(), {
    context: 'Settings',
    isActive: true,
  })

  const slug = slugWorkflowName(name.trim() || 'workflow')
  const displayPath =
    scope === 'project'
      ? `.claude/workflows/${slug}.js`
      : `~/.claude/workflows/${slug}.js`
  const scopeLabel = scope === 'project' ? 'Project' : 'User'

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    return (
      <Byline>
        <KeyboardShortcutHint
          chord="enter"
          action={existingPath ? 'overwrite' : 'save'}
        />
        <KeyboardShortcutHint chord="tab" action="toggle scope" />
        <KeyboardShortcutHint chord="escape" action="cancel" />
      </Byline>
    )
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'tab') {
          event.preventDefault()
          setScope(current => (current === 'project' ? 'user' : 'project'))
          clearStatus()
        }
      }}
    >
      <Dialog
        title="Save dynamic workflow"
        subtitle={
          <Text dimColor>
            {scopeLabel} scope · {displayPath}
          </Text>
        }
        onCancel={() => onDone()}
        color="permission"
        isCancelActive={false}
        inputGuide={renderInputGuide}
      >
        <Box flexDirection="column">
          <Text>Save as:</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text>{'>'}</Text>
            <TextInput
              value={name}
              onChange={value => {
                setName(value)
                clearStatus()
              }}
              onSubmit={submit}
              focus={!saving}
              showCursor={!saving}
              columns={columns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              multiline={false}
            />
          </Box>
          {existingPath ? (
            <Box marginTop={1}>
              <Text color="warning">
                {existingPath} already exists. Press Enter again to overwrite, or change the name.
              </Text>
            </Box>
          ) : null}
          {error ? (
            <Box marginTop={1}>
              <Text color="error">{error}</Text>
            </Box>
          ) : null}
          {saving ? (
            <Box marginTop={1}>
              <Text dimColor>Saving…</Text>
            </Box>
          ) : null}
        </Box>
      </Dialog>
    </Box>
  )
}

/**
 * Official 2.1.153 `js4`.
 */
export function WorkflowsDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  useRegisterOverlay('workflow-history-dialog')
  const { rows } = useTerminalSize()
  const tasks = useAppState(state => state.tasks)
  const setAppState = useSetAppState()
  const [snapshots, setSnapshots] = useState<WorkflowSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewState>({ mode: 'list' })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const skippedListOnMount = useRef(false)

  useEffect(() => {
    let cancelled = false
    void loadWorkflowHistory().then(rows => {
      if (!cancelled) {
        setSnapshots(rows)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const items = useMemo(() => {
    const live = (Object.values(tasks ?? {}) as unknown[]).filter(
      isLocalWorkflowTask,
    )
    const liveRunIds = new Set(live.map(workflowRunIdOf).filter(isPresent))
    const fromDisk = snapshots
      .filter(snapshot => !liveRunIds.has(snapshot.runId))
      .map(asSnapshotItem)
    return [...live.map(asLiveItem), ...fromDisk].sort(compareHistoryItems)
  }, [snapshots, tasks])

  useEffect(() => {
    if (
      !loading &&
      items.length === 1 &&
      view.mode === 'list' &&
      !skippedListOnMount.current
    ) {
      skippedListOnMount.current = true
      setView({ mode: 'detail', itemId: items[0]!.task.id })
    }
  }, [loading, items, view.mode])

  const selected = items[selectedIndex]
  const canSave = Boolean(selected && selected.task.script.length > 0)

  useKeybindings(
    {
      'confirm:previous': () => setSelectedIndex(decrementIndex),
      'confirm:next': () =>
        setSelectedIndex(index => Math.min(items.length - 1, index + 1)),
      'confirm:yes': () => {
        if (selected) {
          setView({ mode: 'detail', itemId: selected.task.id })
        }
      },
    },
    { context: 'Confirmation', isActive: view.mode === 'list' },
  )

  const onBack = () => {
    if (skippedListOnMount.current && items.length <= 1) {
      onDone('Dynamic workflows dialog dismissed', { display: 'system' })
    } else {
      skippedListOnMount.current = false
      setView({ mode: 'list' })
    }
  }

  if (view.mode === 'detail') {
    const item = items.find(row => row.task.id === view.itemId)
    if (!item) {
      setView({ mode: 'list' })
      return null
    }
    const running = item.task.status === 'running'
    return (
      <WorkflowDetail
        item={item}
        onBack={onBack}
        onKill={
          running ? () => killWorkflowTask(item.task.id, setAppState) : undefined
        }
      />
    )
  }

  if (view.mode === 'save') {
    const item = items.find(row => row.task.id === view.itemId)
    if (!item || item.task.script.length === 0) {
      setView({ mode: 'list' })
      return null
    }
    const parsed = parseWorkflowScript(item.task.script)
    const defaultName = !('error' in parsed)
      ? parsed.meta.name
      : slugWorkflowName(item.task.summary ?? item.task.description)
    return (
      <SaveWorkflowDialog
        script={item.task.script}
        defaultName={defaultName}
        onDone={message => {
          if (message) {
            onDone(message, { display: 'system' })
          } else {
            setView({ mode: 'list' })
          }
        }}
      />
    )
  }

  const runningCount = count(items, isRunningItem)
  const completedCount = items.length - runningCount
  const windowSize = clamp(rows - 7, 3, items.length)
  const windowStart = clamp(
    selectedIndex - windowSize + 1,
    0,
    Math.max(0, items.length - windowSize),
  )
  const visible = items.slice(windowStart, windowStart + windowSize)
  const above = windowStart
  const below = items.length - (windowStart + windowSize)

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    return (
      <Byline>
        {items.length > 0 ? (
          <KeyboardShortcutHint chord={['up', 'down']} action="select" />
        ) : null}
        {items.length > 0 ? (
          <KeyboardShortcutHint chord="enter" action="view" />
        ) : null}
        {selected?.task.status === 'running' ? (
          <KeyboardShortcutHint chord="x" action="stop" />
        ) : null}
        {canSave ? <KeyboardShortcutHint chord="s" action="save" /> : null}
        <KeyboardShortcutHint chord="escape" action="close" />
      </Byline>
    )
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={(event: KeyboardEvent) => {
        if (view.mode !== 'list') {
          return
        }
        if (event.ctrl || event.meta) {
          return
        }
        if (event.key === 'x' && selected?.task.status === 'running') {
          event.preventDefault()
          killWorkflowTask(selected.task.id, setAppState)
        } else if (event.key === 's' && canSave && selected) {
          event.preventDefault()
          setView({ mode: 'save', itemId: selected.task.id })
        }
      }}
    >
      <Dialog
        title="Dynamic workflows"
        subtitle={
          items.length === 0 ? undefined : (
            <Text dimColor>
              <Byline>
                {runningCount > 0 ? (
                  <Text>{`${runningCount} running`}</Text>
                ) : null}
                {completedCount > 0 ? (
                  <Text>{`${completedCount} completed`}</Text>
                ) : null}
              </Byline>
            </Text>
          )
        }
        onCancel={() =>
          onDone('Dynamic workflows dialog dismissed', { display: 'system' })
        }
        color="background"
        inputGuide={renderInputGuide}
      >
        {loading ? (
          <LoadingState
            message="Loading dynamic workflow history…"
            dimColor
          />
        ) : items.length === 0 ? (
          <Text>No dynamic workflows in this session.</Text>
        ) : (
          <Box flexDirection="column">
            {above > 0 ? (
              <Text dimColor>
                {'  '}
                {figures.arrowUp} {above} more above
              </Text>
            ) : null}
            {visible.map((item, index) => (
              <HistoryRow
                key={item.task.id}
                item={item}
                isSelected={windowStart + index === selectedIndex}
              />
            ))}
            {below > 0 ? (
              <Text dimColor>
                {'  '}
                {figures.arrowDown} {below} more below
              </Text>
            ) : null}
          </Box>
        )}
      </Dialog>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowsDialog onDone={onDone} />
}
