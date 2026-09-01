/** Official 2.1.139 FleetView job / child shapes (module `ud6`). */

export type FleetChildKind = 'frame' | 'pr' | string

export type FleetChild = {
  kind: FleetChildKind
  href: string
  id: string
}

export type FleetJobState = {
  name?: string
  intent?: string
  template?: string
  createdAt: string
  updatedAt?: string
  sessionId?: string
  resumeSessionId?: string
  children?: FleetChild[]
  color?: string
  tempo?: 'active' | 'blocked' | string
  detail?: string
  needs?: string
  pinned?: boolean
  backend?: string
  sock?: string
  cwd?: string
  worktreePath?: string
  output?: { result?: string; [key: string]: string | undefined }
}

export type FleetJob = {
  id: string
  state: FleetJobState
  activity?: 'success' | 'failure' | 'stopped' | string
}

/** Official 2.1.139 `wm4` group labels. */
export const FLEET_GROUP_LABELS = {
  review: 'Ready for review',
  blocked: 'Needs input',
  working: 'Working',
  done: 'Completed',
} as const

export type FleetGroupId = keyof typeof FLEET_GROUP_LABELS | 'pinned'

export type FleetRow =
  | { kind: 'header'; group: FleetGroupId }
  | { kind: 'job'; job: FleetJob; group: FleetGroupId }
  | { kind: 'fold'; group: 'done'; hidden: number }

export type FleetColumnWidths = {
  age: number
  label: number
  prefix: number
  artifact: number
}

export type FleetGroupMode = 'state' | 'directory'

/** Official 2.1.139 `pB_` PR snapshot used by fleet poll. */
export type FleetPrStatus = {
  state?: 'OPEN' | 'MERGED' | 'CLOSED' | 'DRAFT' | string
  title?: string
  review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks?: { passed: number; failed: number; pending: number }
  additions?: number
  deletions?: number
}

export type FleetRespawnResult = {
  ok: boolean
  alive?: boolean
  error?: string
  short?: string
}

export type FleetViewAction =
  | { type: 'done' }
  | {
      type: 'open'
      job: FleetJob
      query?: string
      collapsed?: string[]
      groupMode?: FleetGroupMode
      jobs?: FleetJob[]
      loopKicks?: Map<string, unknown>
      statuses?: Map<string, unknown>
      statusesTs?: number
      prStatuses?: Map<string, FleetPrStatus | null>
      freshDispatch?: boolean
      respawnResult?: FleetRespawnResult
    }
