import { execFileSync } from 'child_process'
import { readFile } from 'fs/promises'
import { getFsImplementation } from '../../utils/fsOperations.js'

const cache = new Map<number, { at: number; p: Promise<string | undefined> }>()
const CACHE_MS = 60000

/** Official `tC1`. */
async function readProcStart(pid: number): Promise<string | undefined> {
  try {
    const q = await readFile(`/proc/${pid}/stat`, { encoding: 'utf8' })
    const k = q.lastIndexOf(')')
    return q.slice(k + 2).split(' ')[19]
  } catch {
    /* official also tries `ps -o lstart=` */
  }
  try {
    const { execFile } = await import('child_process')
    return await new Promise<string | undefined>(resolve => {
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        {
          timeout: 1000,
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        },
        (err, out) => {
          if (err) resolve(undefined)
          else resolve(out?.trim() || undefined)
        },
      )
    })
  } catch {
    return undefined
  }
}

/** Official `v4H`. */
export function procStartSync(pid: number): string | undefined {
  try {
    const q = getFsImplementation().readFileSync(`/proc/${pid}/stat`, {
      encoding: 'utf8',
    })
    const k = q.lastIndexOf(')')
    return q.slice(k + 2).split(' ')[19]
  } catch {
    try {
      const out = execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        {
          timeout: 1000,
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          encoding: 'utf8',
        },
      )
      return out?.trim() || undefined
    } catch {
      return undefined
    }
  }
}

/** Official `AY$`. */
export function pidStartMatches(pid: number, expected?: string): boolean {
  if (expected === undefined) return true
  const got = procStartSync(pid)
  return got === undefined || got === expected
}

/** Official 2.1.157 `cY$` — memoized start time of this process. */
let ownStart: string | undefined
export async function ownProcStart(): Promise<string | undefined> {
  return (ownStart ??= await procStart(process.pid))
}

/** Official `oy`. */
export async function procStart(
  pid: number,
  opts?: { skipCache?: boolean },
): Promise<string | undefined> {
  const now = Date.now()
  if (!opts?.skipCache) {
    const hit = cache.get(pid)
    if (hit && now - hit.at < CACHE_MS) return hit.p
  }
  const p = readProcStart(pid)
  const entry = { at: now, p }
  cache.set(pid, entry)
  const result = await p
  if (result === undefined && cache.get(pid) === entry) cache.delete(pid)
  return result
}

/** Official `YZ`. */
export async function pidStartMatchesAsync(
  pid: number,
  expected?: string,
): Promise<boolean> {
  if (expected === undefined) return true
  const got = await procStart(pid)
  return got === undefined || got === expected
}

/** Official `N0H`. */
export function killProcessGroup(
  pids: number[],
  expectedStart?: string,
): boolean {
  for (const q of pids) {
    try {
      process.kill(q, 'SIGTERM')
    } catch {
      continue
    }
    setTimeout(
      (k: number, abs: number, start?: string) => {
        if (!pidStartMatches(abs, start)) return
        try {
          process.kill(k, 'SIGKILL')
        } catch {
          /* ignore */
        }
      },
      5000,
      q,
      Math.abs(pids[0]!),
      expectedStart,
    ).unref()
    return true
  }
  return false
}
