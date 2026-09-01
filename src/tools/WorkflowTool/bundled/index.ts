/**
 * Official 2.1.153 `mK4` / `BK4` / `lc` / `xE_` (`initBundledWorkflows`).
 * Bundled script bodies (jf4 / remote inits) are not restored here — the
 * registry starts empty, matching official `mK4=[]` before those inits run.
 */

export type BundledWorkflow = {
  source: 'built-in'
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
  script: string
}

const bundledWorkflows: BundledWorkflow[] = []

/** Official 2.1.153 `BK4`. */
export function getBundledWorkflows(): BundledWorkflow[] {
  return bundledWorkflows
}

/** Official 2.1.153 `lc`. */
export function registerBundledWorkflow(
  script: string,
  meta: Omit<BundledWorkflow, 'source' | 'script'>,
): void {
  bundledWorkflows.push({ source: 'built-in', ...meta, script })
}

/**
 * Official 2.1.153 `xE_`. Built-in script registration is not mounted
 * (would invent jf4 / remote workflow bodies).
 */
export function initBundledWorkflows(): void {}
