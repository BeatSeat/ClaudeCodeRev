import { z } from 'zod/v4'

/** Official `P5` / `Ck$`. */
export const DAEMON_PROTO = 1
export const DAEMON_PROTO_MIN = 1

/** Official `vzH`. */
export const SHORT_RE = /^[a-f0-9]{8}$/

/** Official `MqH`. */
export const MAX_PTY_DIM = 10000

/** Official `Rk$`. */
export const RING_CAP = 262144

/** Official `lRH` / `si6` / `IV4`. */
export const DETACH_OSC = '\x1B_cc-daemon-detach\x1B\\'
export const DETACH_MSG_PREFIX = '\x1B_cc-detach-msg;'
export const DETACH_MSG_SUFFIX = '\x1B\\'

export const LaunchSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('prompt'), args: z.array(z.string()) }),
  z.object({
    mode: z.literal('resume'),
    sessionId: z.string(),
    fork: z.boolean(),
    flagArgs: z.array(z.string()),
  }),
  z.object({
    mode: z.literal('exec'),
    cmd: z.string(),
    args: z.array(z.string()),
  }),
])

/** Official `eT8`. */
export const DispatchSchema = z.object({
  proto: z.number().int().min(DAEMON_PROTO_MIN).max(DAEMON_PROTO),
  short: z.string().regex(SHORT_RE),
  nonce: z.string().regex(SHORT_RE).optional(),
  sessionId: z.string(),
  createdAt: z.number(),
  source: z.enum(['shell', 'slash', 'fleet', 'spare', 'respawn']),
  cwd: z.string(),
  launch: LaunchSchema,
  env: z.record(z.string(), z.string()).default({}),
  reattachEnv: z.record(z.string(), z.string()).optional(),
  worktree: z
    .object({ path: z.string(), ownershipToken: z.string() })
    .optional(),
  isolation: z.enum(['none', 'worktree']).default('none'),
  respawnFlags: z.array(z.string()).default([]),
  attachStallRespawns: z.number().int().optional(),
  agent: z.string().optional(),
  routine: z.string().optional(),
  seed: z
    .object({ intent: z.string(), name: z.string().optional() })
    .optional(),
  cols: z.number().int().positive().max(MAX_PTY_DIM).optional(),
  rows: z.number().int().positive().max(MAX_PTY_DIM).optional(),
})

export type Dispatch = z.infer<typeof DispatchSchema>

/** Official `wJ5` (job `state.json`). */
export const JobStateSchema = z.object({
  state: z.string(),
  detail: z.string(),
  tempo: z.enum(['active', 'idle', 'blocked']).optional(),
  inFlight: z
    .object({
      tasks: z.number(),
      queued: z.number(),
      kinds: z.array(z.string()),
    })
    .optional(),
  needs_you: z.boolean().optional(),
  needs: z.string().optional(),
  block: z
    .object({
      questions: z.array(
        z.object({
          question: z.string(),
          options: z.array(
            z.object({ label: z.string(), description: z.string() }),
          ),
        }),
      ),
    })
    .optional(),
  suggestedReply: z.string().optional(),
  output: z.record(z.string(), z.string()).nullable().default(null),
  children: z
    .array(
      z.object({
        id: z.string(),
        href: z.string(),
        kind: z.enum(['pr', 'frame']).optional(),
      }),
    )
    .nullable()
    .default(null),
  linkScanOffset: z.number().default(0),
  linkScanPath: z.string().optional(),
  template: z.string(),
  routine: z.string().optional(),
  respawnFlags: z.array(z.string()).default([]),
  bgIsolation: z.enum(['none', 'worktree']).optional(),
  providerEnv: z.record(z.string(), z.string()).optional(),
  sessionPermissionRules: z
    .object({ allow: z.array(z.string()), deny: z.array(z.string()) })
    .optional(),
  memoryToggledOff: z.boolean().optional(),
  intent: z.string(),
  initialPrompt: z.string().optional(),
  name: z.string().optional(),
  nameSource: z.enum(['user', 'auto']).optional(),
  color: z.string().optional(),
  sessionId: z.string(),
  resumeSessionId: z.string().optional(),
  daemonShort: z.string().optional(),
  cliVersion: z.string().optional(),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  firstTerminalAt: z.string().nullable().default(null),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  worktreeHookBased: z.boolean().optional(),
  originCwd: z.string().optional(),
  bridgeSessionId: z.string().optional(),
  bridgeOutboundOnly: z.boolean().optional(),
  bridgeSessionSeq: z.number().optional(),
  backend: z.enum(['daemon', 'peer']).catch('daemon').default('daemon'),
  sock: z.string().optional(),
  pid: z.number().optional(),
  pinned: z.boolean().optional(),
  sortOrder: z.number().optional(),
  stateSortOrder: z.number().optional(),
})

export type JobState = z.infer<typeof JobStateSchema>

/** Official `id_`. */
export const RosterEntrySchema = z.object({
  pid: z.number(),
  procStart: z.string().optional(),
  sessionId: z.string(),
  rendezvousSock: z.string(),
  ptySock: z.string().optional(),
  messagingSock: z.string().optional(),
  cliVersion: z.string().optional(),
  startedAt: z.number(),
  attempt: z.number(),
  cwd: z.string(),
  worktreePath: z.string().optional(),
  dispatch: DispatchSchema,
  pendingRespawn: z.literal('upgrade').optional(),
  decModes: z.array(z.number()).optional(),
})

export type RosterEntry = z.infer<typeof RosterEntrySchema>

/** Official `bV4`. */
export const RosterSchema = z.object({
  proto: z.number().int().min(DAEMON_PROTO_MIN).max(DAEMON_PROTO),
  supervisorPid: z.number(),
  updatedAt: z.number(),
  workers: z.record(z.string(), RosterEntrySchema),
  parseFailed: z.boolean().optional(),
})

export type Roster = z.infer<typeof RosterSchema>

export type WorkerPhase =
  | { kind: 'spawning' }
  | { kind: 'running' }
  | { kind: 'upgrading' }
  | { kind: 'retiring'; reason: 'reap' | 'grace' | 'stop' }
  | { kind: 'retired'; outcome: string }

export type WorkerRecord = {
  short: string
  nonce?: string
  sessionId: string
  pid: number
  attempt: number
  startedAt: number
  cwd: string
  backend: 'daemon'
  tempo: string
  state: string
  detail: string
  intent: string
  name?: string
  agent?: string
  routine?: string
  worktreePath?: string
  cliVersion: string
  source: string
  messagingSock?: string
  legacy?: boolean
  outcome?: string
  settledAt?: number
}

export type DaemonOrigin = 'service' | 'transient' | 'foreground'

export type PtyHandle = {
  pid: number
  replPid?: () => number
  replVersion?: () => string | undefined
  onResume?: (cb: () => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
  dispose: () => void
  onData: (cb: (chunk: string) => void) => { dispose: () => void }
  onExit: (cb: (info: { exitCode: number; signal?: string }) => void) => {
    dispose: () => void
  }
}

export type SpawnPty = (
  cmd: string,
  args: string[],
  opts: {
    cols: number
    rows: number
    cwd: string
    env: NodeJS.ProcessEnv
    ptySock: string
    short: string
  },
) => PtyHandle

export type AuthSnapshot = Record<string, unknown>
