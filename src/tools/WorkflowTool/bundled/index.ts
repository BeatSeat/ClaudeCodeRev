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
  /** Official 2.1.160 `qZ8(..., {hidden:!0})` — launchable by name, omitted from listings. */
  hidden?: boolean
}

const bundledWorkflows: BundledWorkflow[] = []

/** Official 2.1.153 `BK4`. */
export function getBundledWorkflows(): BundledWorkflow[] {
  return bundledWorkflows
}

/** Official 2.1.153 `lc` / 2.1.160 `qZ8`. */
export function registerBundledWorkflow(
  script: string,
  meta: Omit<BundledWorkflow, 'source' | 'script'>,
  options?: { hidden?: boolean },
): void {
  bundledWorkflows.push({
    source: 'built-in',
    ...meta,
    script,
    hidden: options?.hidden,
  })
}

/**
 * Official 2.1.160 `yl5(){yX4(),TX4()}`.
 * Land `TX4` only — do not backfill 159 deep-research `yX4`.
 */
export function initBundledWorkflows(): void {
  // Lazy require so this module can export registerBundledWorkflow first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./codeReview.js').registerCodeReviewWorkflow()
}
