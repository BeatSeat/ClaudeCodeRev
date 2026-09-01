import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Box,
  Text,
  useInput,
  useSelection,
  useTerminalFocus,
  useTerminalTitle,
} from '../../ink.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useCopyOnSelect, useSelectionBgColor } from '../../hooks/useCopyOnSelect.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { plural } from '../../utils/stringUtils.js'
import type {
  FleetGroupId,
  FleetGroupMode,
  FleetJob,
  FleetPrStatus,
  FleetRow,
  FleetViewAction,
} from './types.js'
import {
  DISPATCH_MIN_LENGTH,
  FOLD_CLUSTER_MS,
  FOLD_EXTRA,
  fleetViewTitle,
  foldKeepCount,
  formatJobAge,
  groupLabel,
} from './jobHelpers.js'
import { listFleetJobs, type ListedFleetJob } from './listFleetJobs.js'
import { ryz } from './prColumn.js'
import { FleetViewRow } from './FleetViewRow.js'
import { FleetViewHelp } from './FleetViewHelp.js'
import { FleetViewDispatch } from './FleetViewDispatch.js'
import { FleetViewFold } from './FleetViewFold.js'
import {
  followRepinLog,
  pollFleetPrStatuses,
  prHrefsFromJobs,
  prPollInterval,
} from './pollPrStatuses.js'
import {
  armOrDelete,
  canPinJob,
  canRenameJob,
  type DeleteArmed,
  renameJob,
  togglePinned,
} from './fleetActions.js'
import { bgAgentAction, featureOk } from './fleetTelemetry.js'

type Props = {
  onAction: (action: FleetViewAction) => void
  initialJobId?: string
  initialQuery?: string
  initialCollapsed?: string[]
  initialError?: string
  initialGroupMode?: FleetGroupMode
}

const GROUP_ORDER: FleetGroupId[] = [
  'pinned',
  'review',
  'blocked',
  'working',
  'done',
]

function jobAgeMs(job: FleetJob): number {
  return Date.parse(job.state.createdAt)
}

/**
 * Official 2.1.139 `Qm4` table + leftovers: dispatch, fold, pin/rename/delete,
 * `?` help, PR poll, follow re-pin.
 */
export function FleetView({
  onAction,
  initialJobId,
  initialQuery = '',
  initialCollapsed,
  initialError,
  initialGroupMode,
}: Props): React.ReactNode {
  const [listed, setListed] = useState<ListedFleetJob[] | null>(null)
  const [focus, setFocus] = useState(0)
  const [query, setQuery] = useState(initialQuery)
  const [cursorOffset, setCursorOffset] = useState(initialQuery.length)
  const [helpOpen, setHelpOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteArmed, setDeleteArmed] = useState<DeleteArmed | null>(null)
  const [footerError, setFooterError] = useState(initialError)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [attachingId, setAttachingId] = useState<string | null>(null)
  const [groupMode, setGroupMode] = useState<FleetGroupMode>(
    initialGroupMode ?? 'state',
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(initialCollapsed ?? []),
  )
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(new Set())
  const [prStatuses, setPrStatuses] = useState<Map<string, FleetPrStatus | null>>(
    () => new Map(),
  )
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  const followId = useRef<string | null>(initialJobId ?? null)
  const followGroup = useRef<FleetGroupId | null>(null)
  const foldShown = useRef(false)
  const mountedAt = useRef(Date.now())
  const lastPrPoll = useRef(0)
  const selection = useSelection()
  const terminalFocused = useTerminalFocus()
  const { rows: terminalRows } = useTerminalSize()
  useCopyOnSelect(selection, true)
  useSelectionBgColor(selection)

  const exit = useCallback(() => {
    onAction({ type: 'done' })
  }, [onAction])
  const exitState = useExitOnCtrlCDWithKeybindings(exit)

  const refresh = useCallback(async () => {
    const jobs = await listFleetJobs()
    setListed(prev => {
      if (!prev) return jobs
      const pinned = new Map(prev.map(row => [row.job.id, row.job.state.pinned]))
      const names = new Map(prev.map(row => [row.job.id, row.job.state.name]))
      return jobs.map(row => {
        const next = { ...row, job: { ...row.job, state: { ...row.job.state } } }
        const pin = pinned.get(row.job.id)
        const name = names.get(row.job.id)
        if (pin !== undefined) next.job.state.pinned = pin
        if (name !== undefined) next.job.state.name = name
        return next
      })
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void listFleetJobs().then(jobs => {
      if (!cancelled) setListed(jobs)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    featureOk('screen_fleet_view')
  }, [])

  const patchJob = useCallback((id: string, patch: (job: FleetJob) => FleetJob) => {
    setListed(prev =>
      prev?.map(row => (row.job.id === id ? { ...row, job: patch(row.job) } : row)) ??
      prev,
    )
  }, [])

  const jobs = useMemo(() => listed?.map(row => row.job) ?? [], [listed])
  const cols = useMemo(() => ryz(jobs), [jobs])
  const k = foldKeepCount(terminalRows)

  const grouped = useMemo(() => {
    const buckets = new Map<FleetGroupId, ListedFleetJob[]>()
    for (const id of GROUP_ORDER) buckets.set(id, [])
    for (const row of listed ?? []) {
      const group = row.job.state.pinned ? 'pinned' : row.group
      buckets.get(group)?.push(row)
    }
    return buckets
  }, [listed])

  const displayRows = useMemo(() => {
    const done = grouped.get('done') ?? []
    let keepDone = Number.POSITIVE_INFINITY
    if (groupMode === 'directory' && !expandedFolds.has('done')) {
      if (done.length >= k + FOLD_EXTRA) {
        const pivot = jobAgeMs(done[k - 1]!.job)
        let cut = k
        while (
          cut < done.length &&
          pivot - jobAgeMs(done[cut]!.job) < FOLD_CLUSTER_MS
        ) {
          cut++
        }
        const originIdx = Math.max(
          done.findIndex(row => row.job.id === initialJobId),
          done.findIndex(row => row.job.id === followId.current),
        )
        if (done.length - cut >= FOLD_EXTRA && originIdx < cut) {
          keepDone = cut
        }
      }
    }

    const rows: FleetRow[] = []
    let doneSeen = 0
    for (const id of GROUP_ORDER) {
      if (hiddenGroups.has(id) && id !== 'pinned') continue
      const bucket = grouped.get(id) ?? []
      if (bucket.length === 0) continue
      rows.push({ kind: 'header', group: id })
      if (collapsed.has(id)) continue
      for (const row of bucket) {
        if (id === 'done' && doneSeen++ >= keepDone) continue
        rows.push({ kind: 'job', job: row.job, group: id })
      }
    }
    const hidden = doneSeen > keepDone ? doneSeen - keepDone : 0
    if (hidden > 0) {
      rows.push({ kind: 'fold', group: 'done', hidden })
    }
    return { rows, hidden, doneCount: doneSeen }
  }, [
    collapsed,
    expandedFolds,
    grouped,
    groupMode,
    hiddenGroups,
    initialJobId,
    k,
  ])

  useEffect(() => {
    if (displayRows.hidden <= 0 || foldShown.current) return
    foldShown.current = true
  }, [displayRows.hidden])

  const flatJobs = useMemo(
    () => displayRows.rows.filter(row => row.kind === 'job'),
    [displayRows],
  )

  const focusedRow = displayRows.rows[focus]
  const focusedJob = focusedRow?.kind === 'job' ? focusedRow.job : undefined

  useLayoutEffect(() => {
    if (followGroup.current) {
      const idx = displayRows.rows.findIndex(
        row => row.kind === 'header' && row.group === followGroup.current,
      )
      if (idx >= 0 && idx !== focus) setFocus(idx)
      if (idx < 0) followGroup.current = null
      return
    }
    if (!followId.current) return
    const idx = displayRows.rows.findIndex(
      row => row.kind === 'job' && row.job.id === followId.current,
    )
    if (idx < 0) {
      followId.current = null
      return
    }
    if (idx !== focus) {
      followRepinLog(focus, idx, followId.current)
      setFocus(idx)
    }
  }, [displayRows.rows, focus])

  const awaiting = useMemo(
    () => (listed ?? []).filter(row => row.band === 'blocked').length,
    [listed],
  )
  const working = useMemo(
    () => (listed ?? []).filter(row => row.band === 'active').length,
    [listed],
  )

  useTerminalTitle(fleetViewTitle(awaiting))

  useEffect(() => {
    const hrefs = prHrefsFromJobs(jobs)
    if (hrefs.length === 0) return
    const now = Date.now()
    if (now - lastPrPoll.current < prPollInterval(terminalFocused, now - mountedAt.current)) {
      return
    }
    lastPrPoll.current = now
    void pollFleetPrStatuses(hrefs, prStatuses).then(setPrStatuses)
  }, [jobs, prStatuses, terminalFocused])

  const expandFold = useCallback(
    (hidden: number, viaClick = false) => {
      setExpandedFolds(prev => new Set(prev).add('done'))
      void hidden
      void viaClick
    },
    [],
  )

  const openJob = useCallback(
    (job: FleetJob, freshDispatch = false) => {
      setAttachingId(job.id)
      followId.current = job.id
      onAction({
        type: 'open',
        job,
        query,
        collapsed: [...collapsed],
        groupMode,
        jobs,
        statusesTs: Date.now(),
        prStatuses,
        freshDispatch,
      })
    },
    [collapsed, groupMode, jobs, onAction, prStatuses, query],
  )

  const submitDispatch = useCallback(
    (shift: boolean) => {
      const intent = query.trim()
      if (intent.length < DISPATCH_MIN_LENGTH) {
        setFooterError(null)
        setDispatchError('Too short — describe the task')
        return
      }
      setDispatchError(null)
      const id = `${Date.now().toString(16).slice(-8)}`
      const job: FleetJob = {
        id,
        state: {
          intent,
          createdAt: new Date().toISOString(),
          sessionId: id,
        },
        activity: 'flowing',
      }
      followId.current = id
      setListed(prev => [
        ...(prev ?? []),
        {
          job,
          group: 'working',
          band: 'active',
        },
      ])
      setQuery('')
      setCursorOffset(0)
      if (shift) openJob(job, true)
    },
    [openJob, query],
  )

  const moveFocus = useCallback(
    (delta: number) => {
      setFocus(i => {
        const next = Math.min(
          Math.max(displayRows.rows.length - 1, 0),
          Math.max(0, i + delta),
        )
        const row = displayRows.rows[next]
        if (row?.kind === 'job') {
          followId.current = row.job.id
          followGroup.current = null
        } else if (row?.kind === 'header') {
          followId.current = null
          followGroup.current = row.group
        } else {
          followId.current = null
          followGroup.current = null
        }
        return next
      })
    },
    [displayRows.rows],
  )

  useInput((input, key) => {
    if (renaming !== null) {
      if (key.escape) {
        setRenaming(null)
        setRenameDraft('')
        return
      }
      if (key.return && focusedJob) {
        renameJob(
          focusedJob,
          renameDraft,
          name => {
            patchJob(focusedJob.id, job => ({
              ...job,
              state: { ...job.state, name },
            }))
            setRenaming(null)
            setRenameDraft('')
          },
          setFooterError,
        )
        return
      }
      if (key.backspace || key.delete) {
        setRenameDraft(d => d.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setRenameDraft(d => d + input)
      }
      return
    }

    if (key.escape) {
      if (helpOpen) {
        setHelpOpen(false)
        return
      }
      if (query) {
        setQuery('')
        setCursorOffset(0)
        return
      }
      exit()
      return
    }

    if (key.ctrl && input === 'r') {
      if (!focusedJob) return
      if (!canRenameJob(focusedJob)) return
      setRenameDraft(focusedJob.state.name ?? '')
      setRenaming(focusedJob.id)
      return
    }

    if (key.ctrl && input === 't') {
      if (!focusedJob) return
      followId.current = focusedJob.id
      togglePinned(
        focusedJob,
        next => {
          patchJob(focusedJob.id, job => ({
            ...job,
            state: { ...job.state, pinned: next },
          }))
          if (next) {
            setHiddenGroups(prev => {
              if (!prev.has('pinned')) return prev
              const copy = new Set(prev)
              copy.delete('pinned')
              return copy
            })
          }
        },
        setFooterError,
      )
      return
    }

    if (key.ctrl && input === 's') {
      followId.current = focusedJob?.id ?? null
      followGroup.current = null
      setGroupMode(mode => (mode === 'directory' ? 'state' : 'directory'))
      return
    }

    if (key.ctrl && input === 'x') {
      if (focusedRow?.kind === 'header') {
        const bucket = grouped.get(focusedRow.group) ?? []
        followGroup.current = focusedRow.group
        followId.current = null
        for (const row of bucket) {
          const result = armOrDelete(row.job, deleteArmed)
          setDeleteArmed(result.armed)
          if (result.deleted) {
            setListed(prev => prev?.filter(item => item.job.id !== result.deleted!.id) ?? prev)
          }
        }
        return
      }
      const result = armOrDelete(focusedJob, deleteArmed)
      setDeleteArmed(result.armed)
      if (result.deleted) {
        setListed(prev => prev?.filter(item => item.job.id !== result.deleted!.id) ?? prev)
      }
      return
    }

    if (input === '?' && query === '') {
      setHelpOpen(open => !open)
      bgAgentAction('help_toggled')
      return
    }

    if (key.upArrow && !key.shift) {
      if (query.includes('\n')) return
      setFooterError(undefined)
      setDeleteArmed(null)
      moveFocus(-1)
      return
    }
    if (key.downArrow && !key.shift) {
      setFooterError(undefined)
      setDeleteArmed(null)
      moveFocus(1)
      return
    }

    if (key.return) {
      if (query.trim()) {
        submitDispatch(key.shift)
        return
      }
      if (focusedRow?.kind === 'fold') {
        expandFold(focusedRow.hidden)
        return
      }
      if (focusedRow?.kind === 'header') {
        followGroup.current = focusedRow.group
        followId.current = null
        setCollapsed(prev => {
          const next = new Set(prev)
          if (next.has(focusedRow.group)) next.delete(focusedRow.group)
          else next.add(focusedRow.group)
          return next
        })
        return
      }
      if (focusedJob) openJob(focusedJob)
      return
    }

    if (key.backspace || key.delete) {
      setQuery(q => {
        const next = q.slice(0, Math.max(0, cursorOffset - 1)) + q.slice(cursorOffset)
        setCursorOffset(Math.max(0, cursorOffset - 1))
        return next
      })
      return
    }

    if (input && !key.ctrl && !key.meta && input !== '\t') {
      if (helpOpen) setHelpOpen(false)
      setQuery(q => {
        const next = q.slice(0, cursorOffset) + input + q.slice(cursorOffset)
        setCursorOffset(cursorOffset + input.length)
        return next
      })
    }
  })

  return (
    <Box flexDirection="column" width="100%">
      {displayRows.rows.map((row, index) => {
        const isFocused = index === focus
        if (row.kind === 'header') {
          return (
            <Box key={`h:${row.group}`}>
              <Text bold={isFocused} dimColor={!isFocused}>
                {groupLabel(row.group)}
              </Text>
            </Box>
          )
        }
        if (row.kind === 'fold') {
          return (
            <FleetViewFold
              key={`f:${row.group}`}
              hidden={row.hidden}
              isFocused={isFocused}
              onExpand={() => expandFold(row.hidden, true)}
            />
          )
        }
        return (
          <FleetViewRow
            key={row.job.id}
            job={row.job}
            isFocused={isFocused}
            cols={cols}
            age={formatJobAge(row.job)}
            attaching={row.job.id === attachingId}
            deleteArmed={
              deleteArmed?.id === row.job.id
                ? { justKilled: deleteArmed.justKilled }
                : undefined
            }
          />
        )
      })}
      <FleetViewDispatch
        query={query}
        cursorOffset={cursorOffset}
        isFocused={renaming === null}
        isTerminalFocused={terminalFocused}
      />
      {helpOpen && renaming === null ? (
        <FleetViewHelp
          focusedPinned={focusedJob?.state.pinned ?? false}
          canReorder={!!focusedJob && (groupMode === 'state' || (focusedJob.state.pinned ?? false))}
          canRename={canRenameJob(focusedJob) && attachingId === null}
          canPin={canPinJob(focusedJob) && attachingId === null}
          canMention={false}
          altOpenCount={Math.min(9, flatJobs.length)}
        />
      ) : (
        <Box flexShrink={0} paddingLeft={2} height={1}>
          {exitState.pending ? (
            <Text dimColor>
              Press Ctrl-C again to exit
              {working > 0
                ? ` · ${working} ${plural(working, 'agent')} will keep running`
                : ''}
            </Text>
          ) : renaming !== null ? (
            <Text dimColor>
              <KeyboardShortcutHint chord="enter" action="save" format={{ keyCase: 'lower' }} />
              {' · '}
              <KeyboardShortcutHint chord="escape" action="cancel" format={{ keyCase: 'lower' }} />
            </Text>
          ) : deleteArmed ? (
            <Text dimColor>
              <KeyboardShortcutHint chord="ctrl+x" action="confirm" />
            </Text>
          ) : footerError ? (
            <Text color="error" wrap="truncate-end">
              {footerError}
            </Text>
          ) : dispatchError ? (
            <Text color="error" wrap="truncate-end">
              {dispatchError}
            </Text>
          ) : (
            <Text dimColor>
              ? for shortcuts · esc to quit · ctrl+s to switch views
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}
