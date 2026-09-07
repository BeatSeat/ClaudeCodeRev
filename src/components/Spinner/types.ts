// @generated-stub — missing from sourcemap, see scripts/gen-stubs.ts
// Type definitions inferred from codebase usage patterns

export type SpinnerMode = 'loading' | 'responding' | 'tool' | 'compact' | 'thinking' | 'idle'

export type RetryStatus =
  | { kind: 'stalled'; deadline: number }
  | {
      kind: 'retrying'
      error: unknown
      attempt: number
      maxRetries: number
      retryInMs: number
      deadline: number
    }
  | null

export type RGBColor = { r: number; g: number; b: number }
