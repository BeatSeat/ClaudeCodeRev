import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import { uniq } from './array.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getManagedSandboxBwrapPath,
  resolveSandboxBwrapPath,
} from './sandbox/sandbox-adapter.js'

/**
 * Env vars to strip from subprocess environments when running inside GitHub
 * Actions. This prevents prompt-injection attacks from exfiltrating secrets
 * via shell expansion (e.g., ${ANTHROPIC_API_KEY}) in Bash tool commands.
 *
 * The parent claude process keeps these vars (needed for API calls, lazy
 * credential reads). Only child processes (bash, shell snapshot, MCP stdio, LSP, hooks) are scrubbed.
 *
 * GITHUB_TOKEN / GH_TOKEN are intentionally NOT scrubbed — wrapper scripts
 * (gh.sh) need them to call the GitHub API. That token is job-scoped and
 * expires when the workflow ends.
 */
const GHA_SUBPROCESS_SCRUB = [
  // Anthropic auth — claude re-reads these per-request, subprocesses don't need them
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_BEDROCK_MANTLE_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',

  // OTLP exporter headers — documented to carry Authorization=Bearer tokens
  // for monitoring backends; read in-process by OTEL SDK, subprocesses never need them
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // Cloud provider creds — same pattern (lazy SDK reads)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC — consumed by the action's JS before claude spawns;
  // leaking these allows minting an App installation token → repo takeover
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',

  // GitHub Actions artifact/cache API — cache poisoning → supply-chain pivot
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // claude-code-action-specific duplicates — action JS consumes these during
  // prepare, before spawning claude. ALL_INPUTS contains anthropic_api_key as JSON.
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
] as const

/**
 * Returns a copy of process.env with sensitive secrets stripped, for use when
 * spawning subprocesses (Bash tool, shell snapshot, MCP stdio servers, LSP
 * servers, shell hooks).
 *
 * Gated on CLAUDE_CODE_SUBPROCESS_ENV_SCRUB. claude-code-action sets this
 * automatically when `allowed_non_write_users` is configured — the flag that
 * exposes a workflow to untrusted content (prompt injection surface).
 */
// Registered by init.ts after the upstreamproxy module is dynamically imported
// in CCR sessions. Stays undefined in non-CCR startups so we never pull in the
// upstreamproxy module graph (upstreamproxy.ts + relay.ts) via a static import.
let _getUpstreamProxyEnv: (() => Record<string, string>) | undefined

/**
 * Called from init.ts to wire up the proxy env function after the upstreamproxy
 * module has been lazily loaded. Must be called before any subprocess is spawned.
 */
export function registerUpstreamProxyEnvFn(
  fn: () => Record<string, string>,
): void {
  _getUpstreamProxyEnv = fn
}

export function subprocessEnv(): NodeJS.ProcessEnv {
  // CCR upstreamproxy: inject HTTPS_PROXY + CA bundle vars so curl/gh/python
  // in agent subprocesses route through the local relay. Returns {} when the
  // proxy is disabled or not registered (non-CCR), so this is a no-op outside
  // CCR containers.
  const proxyEnv = _getUpstreamProxyEnv?.() ?? {}
  const hasProxy = Object.keys(proxyEnv).length > 0
  const scrub = isEnvTruthy(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)
  // Official 2.1.128 QE: strip every OTEL_* from the env copy so Bash/hooks/
  // MCP/LSP children do not inherit the CLI's OTLP endpoint / headers.
  const hasOtel = Object.keys(process.env).some(k => k.startsWith('OTEL_'))

  if (!hasProxy && !scrub && !hasOtel) {
    return process.env
  }
  const env = { ...process.env, ...proxyEnv }
  for (const k of Object.keys(env)) {
    if (k.startsWith('OTEL_')) {
      delete env[k]
    }
  }
  if (!scrub) {
    return env
  }
  for (const k of GHA_SUBPROCESS_SCRUB) {
    delete env[k]
    // GitHub Actions auto-creates INPUT_<NAME> for `with:` inputs, duplicating
    // secrets like INPUT_ANTHROPIC_API_KEY. No-op for vars that aren't action inputs.
    delete env[`INPUT_${k}`]
  }
  return env
}

/** Official 2.1.98 Ub1 — dotenv stubs for Linux env-scrub bwrap isolation. */
const DOTENV_STUB_NAMES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.test.local',
  '.env.production',
  '.env.production.local',
] as const

type ScrubIsolationSnapshot = {
  home: string
  originalCwd: string
  claudeConfigDir: string | undefined
  GITHUB_PATH: string | undefined
  GITHUB_ENV: string | undefined
  GITHUB_OUTPUT: string | undefined
  GITHUB_STEP_SUMMARY: string | undefined
  GITHUB_STATE: string | undefined
  GITHUB_ACTION_PATH: string | undefined
  GITHUB_EVENT_PATH: string | undefined
}

let scrubEnabledCache: boolean | undefined
let linuxBwrapCache: boolean | undefined
let isolationSnapshot: ScrubIsolationSnapshot | undefined

/** Official 2.1.98 ZP. */
export function isSubprocessEnvScrubEnabled(): boolean {
  if (scrubEnabledCache === undefined) {
    scrubEnabledCache = isEnvTruthy(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)
  }
  return scrubEnabledCache
}

/** Official 2.1.98 eo — linux && bwrap, cached after isolation init. */
export function isLinuxBwrapAvailable(): boolean {
  if (linuxBwrapCache !== undefined) {
    return linuxBwrapCache
  }
  return process.platform === 'linux' && resolveSandboxBwrapPath() !== null
}

export type ScrubSandboxFilesystemPolicy = {
  filesystem: {
    allowWrite: string[]
    denyRead: string[]
    denyWrite: string[]
  }
}

/** Official 2.1.98 lb1. */
export function getScrubSandboxPolicy(): ScrubSandboxFilesystemPolicy {
  const snap = isolationSnapshot
  const home = snap?.home ?? homedir()
  const cwd = snap?.originalCwd ?? getOriginalCwd()
  const actionPath = snap?.GITHUB_ACTION_PATH ?? process.env.GITHUB_ACTION_PATH
  return {
    filesystem: {
      allowWrite: ['home', 'root', 'tmp', 'var', 'opt', 'run', 'mnt'].map(
        name => `/${name}`,
      ),
      denyRead: [
        '/run/docker.sock',
        '/run/containerd/containerd.sock',
        '/run/podman/podman.sock',
        '/run/buildkit/buildkitd.sock',
      ],
      denyWrite: [
        `${home}/.bash_profile`,
        `${home}/.bashrc`,
        `${home}/.bash_aliases`,
        `${home}/.bash_login`,
        `${home}/.bash_logout`,
        `${home}/.profile`,
        `${home}/.zshrc`,
        `${home}/.zprofile`,
        `${home}/.zshenv`,
        `${home}/.zlogin`,
        `${home}/.zlogout`,
        `${home}/.claude`,
        `${home}/.claude.json`,
        snap?.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR,
        `${home}/.gitconfig`,
        `${home}/.config/git`,
        `${home}/.bunfig.toml`,
        `${cwd}/bunfig.toml`,
        `${cwd}/package.json`,
        ...DOTENV_STUB_NAMES.map(name => `${cwd}/${name}`),
        `${home}/.npmrc`,
        `${cwd}/.npmrc`,
        `${home}/.yarnrc`,
        `${home}/.yarnrc.yml`,
        `${cwd}/.yarnrc`,
        `${cwd}/.yarnrc.yml`,
        `${home}/.config/pip`,
        `${home}/.pip`,
        `${cwd}/package-lock.json`,
        `${cwd}/yarn.lock`,
        `${cwd}/pnpm-lock.yaml`,
        `${cwd}/node_modules/.bin`,
        `${cwd}/.git/modules`,
        `${cwd}/scripts`,
        `${cwd}/.claude`,
        `${cwd}/.github`,
        `${home}/.local/bin`,
        snap?.GITHUB_PATH ?? process.env.GITHUB_PATH,
        snap?.GITHUB_ENV ?? process.env.GITHUB_ENV,
        snap?.GITHUB_OUTPUT ?? process.env.GITHUB_OUTPUT,
        snap?.GITHUB_STEP_SUMMARY ?? process.env.GITHUB_STEP_SUMMARY,
        snap?.GITHUB_STATE ?? process.env.GITHUB_STATE,
        actionPath,
        actionPath?.includes('/_actions/')
          ? actionPath.slice(0, actionPath.indexOf('/_actions/') + 9)
          : undefined,
        snap?.GITHUB_EVENT_PATH ?? process.env.GITHUB_EVENT_PATH,
        `${home}/.config/gh`,
        `${home}/.netrc`,
        `${home}/.ssh`,
        `${cwd}/.git/hooks`,
        `${cwd}/.git/config`,
        `${cwd}/.gitmodules`,
        `${cwd}/.git/info/exclude`,
      ].filter((path): path is string => !!path),
    },
  }
}

/**
 * Official 2.1.98 Qb1 — require bwrap on Linux, create stub files so bwrap
 * deny-write mounts have somewhere to bind.
 */
export async function initSubprocessEnvScrubIsolation(): Promise<void> {
  if (!isSubprocessEnvScrubEnabled()) {
    return
  }
  const home = homedir()
  const cwd = getOriginalCwd()
  linuxBwrapCache =
    process.platform === 'linux' && resolveSandboxBwrapPath() !== null
  isolationSnapshot = {
    home,
    originalCwd: cwd,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    GITHUB_PATH: process.env.GITHUB_PATH,
    GITHUB_ENV: process.env.GITHUB_ENV,
    GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
    GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY,
    GITHUB_STATE: process.env.GITHUB_STATE,
    GITHUB_ACTION_PATH: process.env.GITHUB_ACTION_PATH,
    GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
  }
  if (process.platform !== 'linux') {
    return
  }
  if (resolveSandboxBwrapPath() === null) {
    const managed = getManagedSandboxBwrapPath()
    throw new Error(
      managed
        ? `sandbox.bwrapPath is set to ${managed} but it is not an executable file. Fix the path in managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to disable (loses subprocess isolation).`
        : 'bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y bubblewrap, set sandbox.bwrapPath in managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to disable (loses subprocess isolation).',
    )
  }
  const { appendFile, mkdir, open } = await import('fs/promises')
  const uid = process.getuid?.() ?? 0
  await mkdir(join(tmpdir(), `claude-${uid}`), { recursive: true }).catch(
    () => {},
  )
  const stubFiles = [
    `${home}/.gitconfig`,
    `${home}/.bash_profile`,
    `${home}/.bashrc`,
    `${home}/.bash_aliases`,
    `${home}/.profile`,
    `${home}/.zshrc`,
    `${home}/.bunfig.toml`,
    `${home}/.netrc`,
    `${home}/.npmrc`,
    `${home}/.yarnrc`,
    `${home}/.yarnrc.yml`,
    `${cwd}/.npmrc`,
    `${cwd}/.yarnrc`,
    `${cwd}/.yarnrc.yml`,
    `${cwd}/bunfig.toml`,
    `${cwd}/package.json`,
    `${cwd}/.gitmodules`,
    `${cwd}/package-lock.json`,
    `${cwd}/yarn.lock`,
    `${cwd}/pnpm-lock.yaml`,
    ...DOTENV_STUB_NAMES.map(name => `${cwd}/${name}`),
  ]
  for (const file of stubFiles) {
    try {
      await mkdir(dirname(file), { recursive: true })
      await (await open(file, 'a')).close()
    } catch {
      // best-effort stubs
    }
  }
  for (const dir of [
    `${home}/.config/gh`,
    `${home}/.config/git`,
    `${home}/.config/pip`,
    `${home}/.pip`,
    `${cwd}/.claude/commands`,
    `${cwd}/.claude/agents`,
    `${cwd}/node_modules/.bin`,
  ]) {
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      // best-effort stubs
    }
  }
  const excludeNames = [
    'bunfig.toml',
    'package.json',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.gitmodules',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    ...DOTENV_STUB_NAMES,
  ]
  await mkdir(`${cwd}/.git/info`, { recursive: true }).catch(() => {})
  await mkdir(`${cwd}/.git/modules`, { recursive: true }).catch(() => {})
  try {
    await appendFile(
      `${cwd}/.git/info/exclude`,
      `\n# claude-code scrub-mode stubs\n${excludeNames.map(name => `/${name}`).join('\n')}\n`,
    )
  } catch {
    // best-effort exclude
  }
}

export function mergeScrubSandboxConfig<T extends { filesystem?: { allowWrite?: string[]; denyWrite?: string[]; denyRead?: string[] } }>(
  policy: ScrubSandboxFilesystemPolicy,
  userAllowWrite: string[],
  userDenyRead: string[],
  denyWithinAllow: string[],
): T {
  const denyWrite = policy.filesystem.denyWrite
  const allowWrite = uniq([
    ...policy.filesystem.allowWrite,
    ...userAllowWrite.filter(path => path !== '/' && path.length > 0),
  ])
  const extraDeny = denyWithinAllow.filter(
    path =>
      allowWrite.some(allow => path === allow || path.startsWith(`${allow}/`)) &&
      !denyWrite.some(deny => path === deny || path.startsWith(`${deny}/`)),
  )
  return {
    ...policy,
    filesystem: {
      allowWrite,
      denyWrite: uniq([...denyWrite, ...extraDeny]),
      denyRead: uniq([...policy.filesystem.denyRead, ...userDenyRead]),
    },
  } as T
}

/** Official 2.1.119 `Pt8` — `CLAUDE_CODE_SCRIPT_CAPS` call-count gate. */
let scriptCaps: Record<string, number> | null | undefined
const scriptCapCounts = new Map<string, number>()

function loadScriptCaps(): void {
  if (scriptCaps !== undefined) return
  const raw = process.env.CLAUDE_CODE_SCRIPT_CAPS
  if (!raw) {
    scriptCaps = null
    return
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const filtered: Record<string, number> = {}
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === 'number' && Number.isFinite(value) && key.trim()) {
          filtered[key] = value
        }
      }
      scriptCaps = Object.keys(filtered).length > 0 ? filtered : null
    } else {
      scriptCaps = null
    }
  } catch {
    scriptCaps = null
  }
}

export function enforceScriptCaps(command: string): void {
  if (!isSubprocessEnvScrubEnabled()) return
  loadScriptCaps()
  if (!scriptCaps) return
  for (const [token, cap] of Object.entries(scriptCaps)) {
    const hits = command.split(token).length - 1
    if (hits <= 0) continue
    const next = (scriptCapCounts.get(token) ?? 0) + hits
    scriptCapCounts.set(token, next)
    if (next > cap) {
      throw new Error(
        `Script call limit exceeded: ${token} has been called ${next} times (cap: ${cap}). This limit prevents data exfiltration via repeated write operations in untrusted-input workflows.`,
      )
    }
  }
}
