/**
 * memory-write-survey (official 2.1.120 `tengu_slate_siskin`).
 *
 * After the model writes/updates a project MEMORY.md, a confirmation dialog
 * appears showing a one-sentence summary of what was recorded, with a
 * "Keep / Undo" choice. Undo reverts the file (restoring prior content for
 * edits, deleting the file + its entrypoint-index line for new files).
 *
 * This module holds the non-React logic: the GrowthBook config + gate, the
 * per-write record captured by the Write tool, the LLM summarization, and the
 * undo/entrypoint-index helpers. The React surface lives in
 * `useMemoryWriteSurvey.tsx` (state machine) and `MemoryWriteSurvey.tsx`
 * (dialog).
 */
import { randomUUID } from 'crypto'
import type { StructuredPatchHunk } from 'diff'
import { basename, dirname, sep } from 'path'
import { z } from 'zod/v4'
import type { QuerySource } from '../../constants/querySource.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
} from '../../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryWithModel } from '../../services/api/claude.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { errorMessage } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logForDebugging } from '../../utils/debug.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { extractTextContent } from '../../utils/messages.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { writeTextContent } from '../../utils/file.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import { getDefaultSonnetModel } from '../../utils/model/model.js'

// GrowthBook feature name for the whole module (off by default).
const MEMORY_WRITE_SURVEY_FEATURE = 'tengu_slate_siskin'
// Event name for survey appearance/outcome telemetry.
const MEMORY_WRITE_SURVEY_EVENT = 'tengu_memory_write_survey_event'
// Name of the auto-memory entrypoint file that is skipped (it is the index,
// not a recorded memory).
const MEMORY_ENTRYPOINT_FILENAME = 'MEMORY.md'

// Default config, byte-for-byte from the 2.1.120 bundle (`sVK`).
const DEFAULT_MEMORY_WRITE_SURVEY_CONFIG = {
  enabled: false,
  timeoutMs: 8000,
  throttleMs: 30000,
  summaryLineThreshold: 5,
}

type MemoryWriteSurveyConfig = typeof DEFAULT_MEMORY_WRITE_SURVEY_CONFIG

// zod schema matching the bundle's `zk1()` — partial so each field is
// optional and validated independently; an invalid value falls back to the
// defaults below.
const memoryWriteSurveyConfigSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean(),
      timeoutMs: z.number().int().min(1000).max(120000),
      throttleMs: z.number().int().min(0).max(3_600_000),
      summaryLineThreshold: z.number().int().min(1).max(50),
    })
    .partial(),
)

/**
 * Read + validate the `tengu_slate_siskin` config, falling back to defaults.
 * Equivalent to the bundle's `BH6()`.
 */
export function readMemoryWriteSurveyConfig(): MemoryWriteSurveyConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE(
    MEMORY_WRITE_SURVEY_FEATURE,
    DEFAULT_MEMORY_WRITE_SURVEY_CONFIG,
  )
  const parsed = memoryWriteSurveyConfigSchema().safeParse(raw)
  if (!parsed.success) {
    logForDebugging(
      `[memoryWriteSurvey] ${MEMORY_WRITE_SURVEY_FEATURE} failed schema validation; using defaults: ${parsed.error.message}`,
      { level: 'warn' },
    )
  }
  return {
    ...DEFAULT_MEMORY_WRITE_SURVEY_CONFIG,
    ...(parsed.success ? parsed.data : {}),
  }
}

/**
 * Bundle `FH6()` — a hard-coded sub-kill-switch (`return false`). Kept as a
 * function so the override path (`if (devOverride) return true`) mirrors the
 * bundle, but it is permanently off.
 */
function isMemoryWriteSurveyDevOverride(): boolean {
  return false
}

/**
 * Final gate. Equivalent to the bundle's `UH6()`:
 * `config.enabled && isAutoMemoryEnabled() && !isTelemetryDisabled() &&
 * isPolicyAllowed('allow_product_feedback')`, short-circuited by the
 * (always-false) dev override.
 */
export function isMemoryWriteSurveyGateEnabled(): boolean {
  if (isMemoryWriteSurveyDevOverride()) {
    return true
  }
  return (
    readMemoryWriteSurveyConfig().enabled &&
    isAutoMemoryEnabled() &&
    !isTelemetryDisabled() &&
    isPolicyAllowed('allow_product_feedback')
  )
}

/** A single captured memory write, queued in AppState for the survey hook. */
export type MemoryWriteRecord = {
  id: string
  filePath: string
  memoryType: string
  memoryName: string
  isEdit: boolean
  body: string
  afterContent: string
  beforeContent: string | null
  structuredPatch: StructuredPatchHunk[]
  capturedAt: number
}

type CaptureMemoryWriteInput = {
  filePath: string
  afterContent: string
  beforeContent: string | null
  structuredPatch: StructuredPatchHunk[]
}

/** Whether a path sits directly inside the project auto-memory directory. */
export function isMemoryFileInProjectDir(filePath: string): boolean {
  return dirname(filePath) + sep === getAutoMemPath()
}

/** Normalize CRLF newlines for content comparison. Bundle `tVK`. */
export function normalizeNewlines(content: string): string {
  return content.includes('\r') ? content.replace(/\r\n/g, '\n') : content
}

/** Whether a MEMORY.md index line links to the given filename. Bundle `Ok1`. */
export function isEntrypointIndexLineFor(line: string, filename: string): boolean {
  const match = line.match(/\]\((?:\.\/)?([^)]+)\)/)
  return match !== null && match[1] === filename
}

/**
 * Capture a memory write into a survey record, or `null` when the write
 * should not be surveyed. Equivalent to the bundle's `w4$`.
 *
 * `agentId` is passed by the caller: subagent writes are never surveyed.
 */
export function captureMemoryWrite(
  agentId: string | undefined,
  input: CaptureMemoryWriteInput,
): MemoryWriteRecord | null {
  // Subagent writes are out of scope for the survey.
  if (agentId) {
    return null
  }
  if (!isMemoryWriteSurveyGateEnabled()) {
    return null
  }
  if (!isMemoryFileInProjectDir(input.filePath)) {
    return null
  }
  // The entrypoint file is the index, not a recorded memory — skip it.
  if (basename(input.filePath) === MEMORY_ENTRYPOINT_FILENAME) {
    return null
  }
  const { frontmatter, content } = parseFrontmatter(input.afterContent)
  return {
    id: randomUUID(),
    filePath: input.filePath,
    memoryType: String(frontmatter.type ?? '?'),
    memoryName: String(
      frontmatter.name ?? basename(input.filePath).replace(/\.md$/, ''),
    ),
    isEdit: input.beforeContent !== null,
    body: content.trim(),
    afterContent: input.afterContent,
    beforeContent: input.beforeContent,
    structuredPatch: input.structuredPatch,
    capturedAt: Date.now(),
  }
}

/** Remove a record by id, returning the same array reference if unchanged. */
export function removeMemoryWriteRecord(
  records: MemoryWriteRecord[],
  id: string,
): MemoryWriteRecord[] {
  if (records.length === 0) {
    return records
  }
  const filtered = records.filter(record => record.id !== id)
  return filtered.length === records.length ? records : filtered
}

/** Count the lines affected by a write (patch lines for edits, body lines for new). */
export function lineCountForRecord(record: MemoryWriteRecord): number {
  if (record.isEdit) {
    let count = 0
    for (const hunk of record.structuredPatch) {
      count += hunk.lines.length
    }
    return count
  }
  if (record.body === '') {
    return 0
  }
  return record.body.split('\n').length
}

/**
 * Build the LLM summarization user content. Bundle `qkK`: a unified-diff-style
 * rendering for edits, a "New memory" block for new files.
 */
function buildSummarizationContent(record: MemoryWriteRecord): string {
  if (record.isEdit) {
    const lines = [`Edit to ${record.memoryName}:`]
    for (const hunk of record.structuredPatch) {
      lines.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`)
      for (const line of hunk.lines) {
        lines.push(line)
      }
    }
    return lines.join('\n')
  }
  return `New memory ${record.memoryName}:\n${record.body}`
}

// Bundle `o25` (verbatim) — the one-sentence summarization prompt.
const SUMMARIZE_PROMPT =
  'Summarize this memory file update in one short sentence (≤120 chars) for a confirmation dialog. State what was recorded or changed; no preamble.\n\n'

// Bundle `r25` (verbatim) — the summarizer's system prompt.
const SUMMARIZE_SYSTEM_PROMPT: readonly string[] = [
  'You write one-sentence confirmation summaries for an Approve/Reject dialog.',
]

/**
 * Generate a one-sentence summary of a memory write. Bundle `s25`.
 * Returns `null` when telemetry is disabled or the call fails/empties.
 */
export async function summarizeMemoryWrite(
  record: MemoryWriteRecord,
  signal: AbortSignal,
): Promise<string | null> {
  // Telemetry/traffic disabled → do not make the (nonessential) model call.
  if (isTelemetryDisabled()) {
    return null
  }
  try {
    // The bundle uses the verbatim querySource `memory_write_survey_summarize`.
    // The tree's QuerySource is a generated stub narrower than the real enum
    // (other callers — extractMemories, insights — hit the same TS2322), so we
    // cast to keep the verbatim constant without widening the stub.
    const querySource = 'memory_write_survey_summarize' as unknown as QuerySource
    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([...SUMMARIZE_SYSTEM_PROMPT]),
      userPrompt: SUMMARIZE_PROMPT + buildSummarizationContent(record),
      signal,
      options: {
        model: getDefaultSonnetModel(),
        querySource,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 150,
        enablePromptCaching: false,
      },
    })
    return extractTextContent(result.message.content, ' ').trim() || null
  } catch (error) {
    logForDebugging(
      `[memoryWriteSurvey] summarize failed: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Undo a memory write. Bundle `KkK`: if the file changed on disk since the
 * capture, skip (log and keep it); otherwise restore the pre-edit content for
 * edits, or delete the file and its entrypoint-index line for new files.
 */
export async function undoMemoryWrite(record: MemoryWriteRecord): Promise<void> {
  const fs = getFsImplementation()
  try {
    let currentContent: string
    try {
      currentContent = await fs.readFile(record.filePath, { encoding: 'utf8' })
    } catch (error) {
      // File already gone (e.g. user deleted it) — nothing to undo.
      if (isFileNotFound(error)) {
        return
      }
      throw error
    }
    if (
      normalizeNewlines(currentContent) !== normalizeNewlines(record.afterContent)
    ) {
      logForDebugging(
        `[memoryWriteSurvey] skip undo for ${record.filePath}: changed since capture`,
        { level: 'warn' },
      )
      return
    }
    if (record.isEdit && record.beforeContent !== null) {
      writeTextContent(record.filePath, record.beforeContent, 'utf8', 'LF')
      return
    }
    await fs.unlink(record.filePath)
    await removeEntrypointIndexLine(record.filePath)
  } catch (error) {
    if (!isFileNotFound(error)) {
      logForDebugging(
        `[memoryWriteSurvey] undo failed for ${record.filePath}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }
}

/**
 * Remove the memory file's entrypoint-index line (the `[name](path)` link) so
 * the index no longer points at a deleted file. Bundle `fk1`.
 */
async function removeEntrypointIndexLine(filePath: string): Promise<void> {
  const fs = getFsImplementation()
  const entrypointPath = getAutoMemPath() + MEMORY_ENTRYPOINT_FILENAME
  let indexContent: string
  try {
    indexContent = await fs.readFile(entrypointPath, { encoding: 'utf8' })
  } catch (error) {
    if (isFileNotFound(error)) {
      return
    }
    throw error
  }
  const fileName = basename(filePath)
  const lines = indexContent.split('\n')
  const remaining = lines.filter(
    line => !isEntrypointIndexLineFor(line, fileName),
  )
  if (remaining.length === lines.length) {
    return
  }
  writeTextContent(entrypointPath, remaining.join('\n'), 'utf8', 'LF')
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

// ---- Telemetry ----------------------------------------------------------

export type MemoryWriteSurveyOutcome =
  | 'appeared'
  | 'approve'
  | 'reject'
  | 'timeout'

/**
 * Emit a `tengu_memory_write_survey_event` + the shared `feedback_survey`
 * OTel event. Equivalent to the bundle's `G` callback.
 */
export function logMemoryWriteSurveyEvent(
  eventType: MemoryWriteSurveyOutcome,
  record: MemoryWriteRecord,
  meta: {
    lineCount: number
    wasSummarized: boolean
    queueDepth: number
  },
): void {
  logEvent(MEMORY_WRITE_SURVEY_EVENT, {
    event_type:
      eventType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id:
      record.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    memory_type:
      record.memoryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    is_edit: record.isEdit,
    line_count: meta.lineCount,
    was_summarized: meta.wasSummarized,
    queue_depth: meta.queueDepth,
  })
  void logFeedbackSurveyOTelEvent(eventType, record.id)
}

async function logFeedbackSurveyOTelEvent(
  eventType: MemoryWriteSurveyOutcome,
  appearanceId: string,
): Promise<void> {
  await logOTelEvent('feedback_survey', {
    event_type: eventType,
    appearance_id: appearanceId,
    survey_type: 'memory_write',
  })
}
