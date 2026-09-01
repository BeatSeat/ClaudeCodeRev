import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isENOENT } from './errors.js'
import { logForDebugging } from './debug.js'
import { jsonParse } from './slowOperations.js'

const LastUpdateResultSchema = z.object({
  timestamp: z.string(),
  path: z.enum(['npm-global', 'npm-local', 'native']),
  outcome: z.enum(['success', 'failed']),
  status: z.string(),
  version_from: z.string(),
  version_to: z.string().nullable(),
  error_code: z.string().nullable(),
})

export type LastUpdateResult = z.infer<typeof LastUpdateResultSchema>

export function getLastUpdateResultPath(): string {
  return join(getClaudeConfigHomeDir(), '.last-update-result.json')
}

export async function recordUpdateResult(
  result: LastUpdateResult,
): Promise<void> {
  try {
    const path = getLastUpdateResultPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(result))
  } catch (error) {
    logForDebugging(`Failed to record update result: ${error}`, {
      level: 'error',
    })
  }
}

export async function readLastUpdateResult(): Promise<LastUpdateResult | null> {
  let raw: string
  try {
    raw = await readFile(getLastUpdateResultPath(), 'utf8')
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Failed to read update result: ${error}`, {
        level: 'error',
      })
    }
    return null
  }
  try {
    const parsed = LastUpdateResultSchema.safeParse(jsonParse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function formatLastUpdateResult(
  result: LastUpdateResult | null,
): string {
  if (!result) return 'none recorded'
  const date = result.timestamp.slice(0, 10)
  switch (result.outcome) {
    case 'success':
      return result.version_to
        ? `success \u2192 ${result.version_to} (${date})`
        : `success (${date})`
    case 'failed':
      return `failed (${result.status}) \u2014 ${date}`
  }
}
