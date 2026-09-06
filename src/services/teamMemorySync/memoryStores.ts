import { z } from 'zod/v4'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse } from '../../utils/slowOperations.js'

export type MemoryStoreEntry = {
  path: string
  mode: 'rw' | 'ro'
  mount: string
  /** Official 2.1.170 `Ku_` / 2.1.172 `qXH` — default `"team"`. */
  scope: 'user' | 'team'
  promptIndex?: string
}

const MOUNT_MESSAGE = 'mount must match /^[A-Za-z0-9_-]+$/'

/** Official 2.1.143 `nA5`: path-absolute and must not override the host. */
function isSafeAbsoluteStorePath(path: string): boolean {
  if (!path.startsWith('/')) return false
  try {
    return new URL(path, 'https://sentinel.invalid').origin === 'https://sentinel.invalid'
  } catch {
    return false
  }
}

const storePathSchema = lazySchema(() =>
  z.string().min(1).refine(isSafeAbsoluteStorePath, {
    message: 'path must be path-absolute and must not override the host',
  }),
)

/** Official 2.1.172 `IV6`. */
function isSafePromptIndex(value: string): boolean {
  if (value.length === 0) {
    return false
  }
  return value
    .split('/')
    .every(segment => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..')
}

const storeEntrySchema = lazySchema(() =>
  z.union([
    storePathSchema(),
    z.object({
      path: storePathSchema(),
      mode: z.enum(['rw', 'ro']).default('rw'),
      scope: z.enum(['user', 'team']).default('team'),
      mount: z
        .string()
        .min(1)
        .refine(value => /^[A-Za-z0-9_-]+$/.test(value), {
          message: MOUNT_MESSAGE,
        })
        .optional(),
      promptIndex: z
        .string()
        .min(1)
        .refine(isSafePromptIndex, {
          message:
            'promptIndex segments must match [A-Za-z0-9._-]+ and must not be . or ..',
        })
        .optional(),
    }),
  ]),
)

/** Official 2.1.143 `iA5`. */
export function deriveMemoryStoreMount(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  if (base === '') {
    throw new Error(`cannot derive mount name from path: ${path}`)
  }
  const mount = base.replace(/[^A-Za-z0-9_-]/g, '-')
  if (mount === '' || mount === '.' || mount === '..') {
    throw new Error(`derived mount name is not a valid path segment: ${base}`)
  }
  return mount
}

/**
 * Official 2.1.143 `V64`: parse `CLAUDE_MEMORY_STORES` JSON.
 * Returns null when unset/empty. Throws on invalid JSON or schema.
 */
export function parseClaudeMemoryStores(): MemoryStoreEntry[] | null {
  const raw = process.env.CLAUDE_MEMORY_STORES
  if (!raw || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = jsonParse(raw)
  } catch (err) {
    throw new Error(
      `CLAUDE_MEMORY_STORES is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = z.array(storeEntrySchema()).safeParse(parsed)
  if (!result.success) {
    throw new Error(`CLAUDE_MEMORY_STORES failed validation: ${result.error.message}`)
  }
  const stores: MemoryStoreEntry[] = []
  const mounts = new Set<string>()
  let hasUserScope = false
  for (const entry of result.data) {
    const spec =
      typeof entry === 'string'
        ? { path: entry, mode: 'rw' as const, scope: 'team' as const }
        : entry
    const mount = spec.mount ?? deriveMemoryStoreMount(spec.path)
    if (mounts.has(mount)) {
      throw new Error(`CLAUDE_MEMORY_STORES has duplicate mount: ${mount}`)
    }
    mounts.add(mount)
    if (spec.scope === 'user') {
      if (hasUserScope) {
        throw new Error('CLAUDE_MEMORY_STORES has more than one scope:"user" entry')
      }
      hasUserScope = true
    }
    stores.push({
      path: spec.path,
      mode: spec.mode,
      scope: spec.scope,
      mount,
      ...(spec.promptIndex !== undefined && { promptIndex: spec.promptIndex }),
    })
  }
  if (stores.length === 0) {
    return null
  }
  logForDebugging(
    `memory-stores: parsed ${stores.length} store(s): ` +
      stores.map(store => `${store.mount}(${store.mode})`).join(', '),
    { level: 'debug' },
  )
  return stores
}

/** Official 2.1.172 `Ru_` — swallow parse errors for prompt assembly. */
export function tryParseClaudeMemoryStores(): MemoryStoreEntry[] | null {
  try {
    return parseClaudeMemoryStores()
  } catch {
    return null
  }
}
