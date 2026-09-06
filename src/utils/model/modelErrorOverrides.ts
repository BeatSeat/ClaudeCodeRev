/**
 * Official 2.1.178 `nZ6` / `FcK` / `QcK` / `dcK` / `BcK` / `UcK` / `ccK`.
 * GrowthBook map `tengu-model-error-overrides`.
 */
import {
  getDynamicConfig_BLOCKS_ON_INIT,
  getDynamicConfig_CACHED_MAY_BE_STALE,
} from '../../services/analytics/growthbook.js'

export const TENGU_MODEL_ERROR_OVERRIDES = 'tengu-model-error-overrides'

type OverrideEntry = {
  block?: unknown
  pickerHint?: unknown
}

const EMPTY_OVERRIDES: Record<string, OverrideEntry> = {}

/** Official 2.1.178 `BcK`. */
function asOverrideMap(raw: unknown): Record<string, OverrideEntry> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, OverrideEntry>)
    : EMPTY_OVERRIDES
}

/** Official 2.1.178 `UcK`. */
function entryForModel(
  raw: unknown,
  model: string,
): OverrideEntry | undefined {
  if (typeof model !== 'string' || model === '') return
  const entry = asOverrideMap(raw)[model]
  return typeof entry === 'object' && entry !== null ? entry : undefined
}

/** Official 2.1.178 `ccK`. */
function trimOverrideText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Official 2.1.178 `gcK`. */
function blockText(entry: OverrideEntry | undefined): string | null {
  return trimOverrideText(entry?.block)
}

/** Official 2.1.178 `FcK`. */
export function hasModelErrorOverrides(): boolean {
  const map = asOverrideMap(
    getDynamicConfig_CACHED_MAY_BE_STALE(
      TENGU_MODEL_ERROR_OVERRIDES,
      EMPTY_OVERRIDES,
    ),
  )
  return Object.keys(map).length > 0
}

/** Official 2.1.178 `QcK`. */
export async function getModelErrorOverrideBlock(
  canonicalModel: string,
): Promise<string | null> {
  const raw = await getDynamicConfig_BLOCKS_ON_INIT(
    TENGU_MODEL_ERROR_OVERRIDES,
    EMPTY_OVERRIDES,
  )
  return blockText(entryForModel(raw, canonicalModel))
}

/**
 * Official 2.1.178 `dcK` — picker hint, falling back to the block string.
 */
export function getModelErrorOverridePickerHint(
  canonicalModel: string,
): string | null {
  const entry = entryForModel(
    getDynamicConfig_CACHED_MAY_BE_STALE(
      TENGU_MODEL_ERROR_OVERRIDES,
      EMPTY_OVERRIDES,
    ),
    canonicalModel,
  )
  const block = blockText(entry)
  if (block === null) return null
  return trimOverrideText(entry?.pickerHint) ?? block
}
