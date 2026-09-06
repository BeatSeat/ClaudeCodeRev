import { basename, isAbsolute } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../../utils/debug.js'

/** Official `P5` / `Ck$`. */
export const DAEMON_PROTO = 1
export const DAEMON_PROTO_MIN = 1

/** Official `vzH` / `ZP7`. */
export const SHORT_RE = /^[a-f0-9]{8}$/

/** Official 2.1.176 `EK5` / `uN` — session resume UUID. */
const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Official 2.1.176 `xK5`. */
const BRIDGE_SESSION_RE = /^(cse_|session_)[A-Za-z0-9_-]{1,128}$/

/** Official 2.1.176 `uN`. */
function parseSessionUuid(H: unknown): string | null {
  if (typeof H !== 'string') return null
  return SESSION_UUID_RE.test(H) ? H : null
}

/** Official 2.1.176 `d0$` (175 `pG$`). */
function dropMalformed<T>(
  field: string,
  ok: (v: T) => boolean,
): (q: T) => T | undefined {
  return q => {
    if (ok(q)) return q
    logForDebugging(
      `[jobs] dropped malformed ${field} from persisted job state`,
      { level: 'warn' },
    )
    return undefined
  }
}

/** Official 2.1.176 `$e8`. */
function stripWindowsLongPathPrefix(H: string): string {
  if (H.startsWith('\\\\?\\UNC\\')) return '\\\\' + H.slice(8)
  if (H.startsWith('\\\\?\\') && H.length >= 7 && H[5] === ':') return H.slice(4)
  return H
}

/** Official 2.1.176 `Yhq`. */
function isDotOrForwardSlashUnc(H: string): boolean {
  return /(^|[\\/])\.{1,2}([\\/]|$)/.test(H) || H.includes('/')
}

/** Official 2.1.176 `cA`. */
function isUncPrefix(H: string): boolean {
  return /^[\\/]{2}/.test(H)
}

/** Official 2.1.176 `PD`. */
function isWslUnc(H: string): boolean {
  return /^[\\/]{2}wsl(\$|\.localhost)[\\/]/i.test(H)
}

/** Official 2.1.176 `SkH`. */
export function isWindowsNetworkPath(H: string): boolean {
  if (/^\\\\\?\\volume\{/i.test(H)) return isDotOrForwardSlashUnc(H)
  const n = stripWindowsLongPathPrefix(H)
  if (n !== H && isDotOrForwardSlashUnc(n)) return true
  return isUncPrefix(n) && !isWslUnc(n)
}

/** Official 2.1.176 `FP` — neutralize UNC before persist/respawn. */
export function neutralizeWindowsNetworkPath(H: string): string {
  if (isWindowsNetworkPath(H)) {
    return stripWindowsLongPathPrefix(H).replace(/^([\\/])[\\/]+/, '$1')
  }
  return H
}

/** Official 2.1.176 `g0$`. */
function persistedPathString() {
  return z.string().transform(neutralizeWindowsNetworkPath)
}

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
  linkScanPath: persistedPathString()
    .transform(
      dropMalformed<string>(
        'linkScanPath',
        H =>
          isAbsolute(H) &&
          H.endsWith('.jsonl') &&
          parseSessionUuid(basename(H, '.jsonl')) !== null,
      ),
    )
    .optional(),
  template: z.string(),
  routine: z.string().optional(),
  respawnFlags: z.array(z.string()).default([]).transform(sanitizeRespawnFlags),
  bgIsolation: z.enum(['none', 'worktree']).optional(),
  providerEnv: z.record(z.string(), z.string()).transform(sanitizeProviderEnv).optional(),
  sessionPermissionRules: z
    .object({ allow: z.array(z.string()), deny: z.array(z.string()) })
    .optional(),
  memoryToggledOff: z.boolean().optional(),
  intent: z.string(),
  initialPrompt: z.string().optional(),
  name: z.string().optional(),
  nameSource: z.enum(['user', 'auto']).optional(),
  color: z.string().optional(),
  sessionId: persistedPathString(),
  resumeSessionId: z
    .string()
    .transform(dropMalformed<string>('resumeSessionId', H => parseSessionUuid(H) !== null))
    .optional(),
  daemonShort: z
    .string()
    .transform(dropMalformed<string>('daemonShort', H => SHORT_RE.test(H)))
    .optional(),
  cliVersion: z.string().optional(),
  cwd: persistedPathString(),
  createdAt: z.string(),
  updatedAt: z.string(),
  firstTerminalAt: z.string().nullable().default(null),
  worktreePath: persistedPathString().optional(),
  worktreeBranch: z.string().optional(),
  worktreeHookBased: z.boolean().optional(),
  originCwd: persistedPathString().optional(),
  bridgeSessionId: z
    .string()
    .transform(dropMalformed<string>('bridgeSessionId', H => BRIDGE_SESSION_RE.test(H)))
    .optional(),
  bridgeOutboundOnly: z.boolean().optional(),
  bridgeSessionSeq: z
    .number()
    .transform(
      dropMalformed<number>(
        'bridgeSessionSeq',
        H => Number.isInteger(H) && H >= 0,
      ),
    )
    .optional(),
  backend: z
    .enum(['daemon', 'peer', 'remote'])
    .catch('daemon')
    .default('daemon')
    .transform(val => {
      if (val === 'daemon') return val
      logForDebugging(
        `[jobs] coerced persisted backend '${val}' to 'daemon' — peer/remote rows are never written to disk`,
        { level: 'warn' },
      )
      return 'daemon'
    }),
  sock: z.string().optional(),
  pid: z.number().optional(),
  pinned: z.boolean().optional(),
  sortOrder: z.number().optional(),
  stateSortOrder: z.number().optional(),
})

const ALLOWLISTED_PROVIDER_ENV_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_INTERNAL_FC_OVERRIDES',
  'ANTHROPIC_MODEL',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
])

function sanitizeProviderEnv(
  env: Record<string, string>,
): Record<string, string> | undefined {
  const stripped = Object.keys(env).filter(k => !ALLOWLISTED_PROVIDER_ENV_KEYS.has(k))
  if (stripped.length === 0) return env
  logForDebugging(
    `[jobs] stripped non-allowlisted providerEnv key(s) from persisted job state: ${stripped.join(', ')}`,
    { level: 'warn' },
  )
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (ALLOWLISTED_PROVIDER_ENV_KEYS.has(k)) {
      result[k] = neutralizeWindowsNetworkPath(v)
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const ALLOWLISTED_PARAM_FLAGS = new Set([
  '--exec',
  '--model',
  '-m',
  '--permission-mode',
  '--agent',
  '--agents',
  '--routine',
  '--effort',
  '--add-dir',
  '--mcp-config',
  '--settings',
  '--setting-sources',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--fallback-model',
  '--advisor',
  '--channels',
  '--permission-prompt-tool',
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--disallowedTools',
  '--tools',
  '--session-id',
  '--debug-file',
  '-n',
  '--name',
  '--autocompact',
  '--betas',
  '--file',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--max-turns',
  '--task-budget',
  '--plan-mode-instructions',
  '--plugin-dir',
  '--plugin-url',
  '--resume-session-at',
  '--rewind-files',
  '--thinking',
  '--thinking-display',
  '--remote-control-session-name-prefix',
])

const MULTI_PARAM_FLAGS = new Set([
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--disallowedTools',
  '--tools',
  '--mcp-config',
  '--betas',
  '--add-dir',
  '--file',
  '--channels',
])

const ALLOWLISTED_BOOLEAN_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--strict-mcp-config',
  '--dangerously-allow-browser-network-access',
  '--disable-slash-commands',
  '--verbose',
  '--reply-on-resume',
  '--ide',
  '--chrome',
  '--no-chrome',
  '--bare',
  '--mcp-debug',
  '--brief',
  '--remote-control',
  '--rc',
])

/**
 * Official 2.1.178 `$zz` idle gate. Empty-intent when there is no agent
 * initialPrompt, no exec, no leftover prompt, and `--reply-on-resume` is
 * not among unconsumed argv. Spawn itself lives in `src/cli/bg.ts` (out of lock).
 */
export function isEmptyIdleIntent(
  args: string[],
  consumed: Set<number>,
  opts?: { initialPrompt?: string; exec?: string; prompt?: string },
): boolean {
  return (
    !opts?.initialPrompt &&
    !opts?.exec &&
    !opts?.prompt &&
    !args.some((a, i) => !consumed.has(i) && a === '--reply-on-resume')
  )
}

function sanitizeRespawnFlags(flags: string[]): string[] {
  const kept: string[] = []
  const stripped: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!
    if (!flag.startsWith('-')) {
      stripped.push(flag)
      continue
    }
    const eqIdx = flag.indexOf('=')
    const flagName = eqIdx === -1 ? flag : flag.slice(0, eqIdx)
    if (eqIdx !== -1 && !ALLOWLISTED_PARAM_FLAGS.has(flagName) && ALLOWLISTED_BOOLEAN_FLAGS.has(flagName)) {
      kept.push(flagName)
      stripped.push(flag)
      continue
    }
    const isParam = eqIdx === -1 && ALLOWLISTED_PARAM_FLAGS.has(flagName)
    const isAllowed = eqIdx === -1
      ? ALLOWLISTED_BOOLEAN_FLAGS.has(flagName) || (isParam && flags[i + 1] !== undefined)
      : ALLOWLISTED_PARAM_FLAGS.has(flagName)
    const target = isAllowed ? kept : stripped
    target.push(flag)
    if (isParam && flags[i + 1] !== undefined) {
      target.push(flags[++i]!)
    }
    if (!isAllowed || (isParam && MULTI_PARAM_FLAGS.has(flagName))) {
      while (flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('-')) {
        target.push(flags[++i]!)
      }
    }
  }
  if (stripped.length > 0) {
    logForDebugging(
      `[jobs] stripped non-allowlisted respawnFlags token(s) from persisted job state: ${stripped.join(' ')}`,
      { level: 'warn' },
    )
  }
  return normalizeRespawnFlags(kept)
}

function normalizeRespawnFlags(flags: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!
    const eqIdx = flag.indexOf('=')
    const flagName = eqIdx === -1 ? flag : flag.slice(0, eqIdx)
    const tokens = [flag]
    if (eqIdx === -1 && ALLOWLISTED_PARAM_FLAGS.has(flagName) && flags[i + 1] !== undefined) {
      tokens.push(flags[++i]!)
    }
    if (MULTI_PARAM_FLAGS.has(flagName)) {
      while (flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('-')) {
        tokens.push(flags[++i]!)
      }
    }
    result.push(...tokens)
  }
  return result
}

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
