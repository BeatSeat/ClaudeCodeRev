import { randomBytes } from 'crypto'
import { z } from 'zod/v4'
import {
  MAX_DESIGN_PATH_LENGTH,
  MAX_GLOB_WILDCARDS,
  PLAN_ID_RE,
} from './constants.js'

export type DesignPlan = {
  projectId: string
  writes: string[]
  deletes: string[]
  localDir?: string
}

const plans = new Map<string, DesignPlan>()

const planSchema = z.object({
  projectId: z.string(),
  writes: z.array(z.string()),
  deletes: z.array(z.string()),
  localDir: z.string().optional(),
})

/** Official 2.1.160 `yk`. */
export function normalizeDesignPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part !== '' && part !== '.')
    .join('/')
}

/** Official 2.1.160 `Nc6`. */
export function isReservedDesignPath(p: string): boolean {
  const n = normalizeDesignPath(p).toLowerCase()
  return (
    n === 'claude.md' ||
    n.startsWith('claude.md/') ||
    n === '.claude' ||
    n.startsWith('.claude/')
  )
}

/** Official 2.1.160 `sRH`. */
export function isGlobPath(p: string): boolean {
  return /[*?]/.test(p)
}

/** Official 2.1.160 `TJ4`. */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  let i = 0
  let wildcards = 0
  const bump = (): void => {
    if (++wildcards > MAX_GLOB_WILDCARDS) {
      throw new Error(
        `glob "${pattern}" exceeds ${MAX_GLOB_WILDCARDS} '*'/'**' wildcards`,
      )
    }
  }
  while (i < pattern.length) {
    const ch = pattern.charAt(i)
    if (ch === '*' && pattern.charAt(i + 1) === '*') {
      bump()
      if (pattern.charAt(i + 2) === '/') {
        out += '(?:.*/)?'
        i += 3
      } else {
        out += '.*'
        i += 2
      }
    } else if (ch === '*') {
      bump()
      out += '[^/]*'
      i += 1
    } else if (ch === '?') {
      out += '[^/]'
      i += 1
    } else if (/[.+^$|()[\]{}\\]/.test(ch)) {
      out += '\\' + ch
      i += 1
    } else {
      out += ch
      i += 1
    }
  }
  return new RegExp(`^${out}$`)
}

/** Official 2.1.160 `iv$`. */
export function pathMatchesPlan(path: string, allowed: string[]): boolean {
  const normalized = normalizeDesignPath(path)
  if (!normalized) return false
  if (normalized.length > MAX_DESIGN_PATH_LENGTH) return false
  if (normalized.split('/').includes('..') || normalized.includes('\x00')) {
    return false
  }
  for (const entry of allowed) {
    const allowedPath = normalizeDesignPath(entry)
    if (isGlobPath(allowedPath)) {
      try {
        if (globToRegExp(allowedPath).test(normalized)) return true
      } catch {
        // invalid glob — skip
      }
    } else if (allowedPath === normalized) {
      return true
    }
  }
  return false
}

/** Official 2.1.160 `Bc5`. */
export function makePlanId(projectId: string): string {
  const slug =
    projectId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'anon'
  const hex = randomBytes(6).toString('hex')
  return `plan_${slug}_${hex}`
}

/** Official 2.1.160 `VJ4`. */
export function registerPlan(plan: {
  projectId: string
  writes: string[]
  deletes: string[]
  localDir?: string
}): string {
  const shaped = {
    projectId: plan.projectId,
    writes: plan.writes.map(normalizeDesignPath),
    deletes: plan.deletes.map(normalizeDesignPath),
    ...(plan.localDir !== undefined ? { localDir: plan.localDir } : {}),
  }
  const parsed = planSchema.safeParse(shaped)
  if (!parsed.success) {
    throw new Error('registerPlan: plan failed shape validation')
  }
  for (const entry of [...parsed.data.writes, ...parsed.data.deletes]) {
    if (isGlobPath(entry)) globToRegExp(entry)
  }
  const id = makePlanId(plan.projectId)
  plans.set(id, parsed.data)
  return id
}

/** Official 2.1.160 `rv$`. */
export function getPlan(planId: string): DesignPlan | null {
  if (!PLAN_ID_RE.test(planId)) return null
  return plans.get(planId) ?? null
}
