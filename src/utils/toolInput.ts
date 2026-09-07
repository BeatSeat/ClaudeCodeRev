export const UNPARSED_TOOL_INPUT = '__unparsedToolInput'

export type UnparsedToolInput = {
  [UNPARSED_TOOL_INPUT]: {
    raw: string
    len: number
  }
}

export function isUnparsedToolInput(value: unknown): value is UnparsedToolInput {
  if (typeof value !== 'object' || value === null) return false
  const entries = Object.entries(value)
  if (entries.length !== 1) return false
  const [key, val] = entries[0]
  return (
    key === UNPARSED_TOOL_INPUT &&
    typeof val === 'object' &&
    val !== null &&
    typeof (val as { raw?: unknown }).raw === 'string' &&
    typeof (val as { len?: unknown }).len === 'number'
  )
}
