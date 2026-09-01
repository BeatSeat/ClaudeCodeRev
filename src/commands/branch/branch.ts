import { randomUUID, type UUID } from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, unlink } from 'fs/promises'
import { createInterface } from 'readline'
import { finished } from 'stream/promises'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  ContentReplacementEntry,
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  isTranscriptMessage,
  saveCustomTitle,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { escapeRegExp } from '../../utils/stringUtils.js'

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

/**
 * Derive a single-line title base from the first user message.
 * Collapses whitespace — multiline first messages (pasted stacks, code)
 * otherwise flow into the saved title and break the resume hint.
 */
export function deriveFirstPrompt(
  firstUserMessage: Extract<SerializedMessage, { type: 'user' }> | undefined,
): string {
  const content = firstUserMessage?.message?.content
  if (!content) return 'Branched conversation'
  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )?.text
  if (!raw) return 'Branched conversation'
  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Branched conversation'
  )
}

/**
 * Creates a fork of the current conversation by streaming the transcript.
 * Official 2.1.116 Vv7: no 50MB size gate — readline copy instead of
 * readFile + parseJSONL of the whole file.
 */
async function createFork(
  customTitle?: string,
  extraMessages?: TranscriptMessage[],
): Promise<{
  sessionId: UUID
  title: string | undefined
  forkPath: string
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementEntry['replacements']
}> {
  const forkSessionId = randomUUID() as UUID
  const originalSessionId = getSessionId()
  const projectDir = getProjectDir(getOriginalCwd())
  const forkSessionPath = getTranscriptPathForSession(forkSessionId)
  const currentTranscriptPath = getTranscriptPath()

  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  let input
  try {
    input = createReadStream(currentTranscriptPath, { encoding: 'utf8' })
    await once(input, 'open')
  } catch (error) {
    if (isENOENT(error)) {
      throw new Error('No conversation to branch')
    }
    logError(error)
    throw error
  }

  const output = createWriteStream(forkSessionPath, {
    encoding: 'utf8',
    mode: 0o600,
  })
  let writeError: Error | null = null
  output.on('error', err => {
    writeError = err instanceof Error ? err : new Error(String(err))
  })

  const rl = createInterface({ input, crlfDelay: Infinity })
  let parentUuid: UUID | null = null
  let lastOriginal: TranscriptMessage | null = null
  const serializedMessages: SerializedMessage[] = []
  const contentReplacementRecords: ContentReplacementEntry['replacements'] = []

  const cleanup = async () => {
    output.destroy()
    await unlink(forkSessionPath).catch(() => {})
  }
  const writeLine = async (line: string) => {
    if (writeError) {
      await cleanup()
      throw writeError
    }
    if (!output.write(line)) {
      await once(output, 'drain').catch(() => {})
    }
  }

  try {
    for await (const line of rl) {
      if (line.length === 0) continue
      let entry: unknown
      try {
        entry = jsonParse(line)
      } catch {
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      const rec = entry as Record<string, unknown>
      if (
        rec.type === 'content-replacement' &&
        rec.sessionId === originalSessionId
      ) {
        const replacements = rec.replacements
        if (Array.isArray(replacements)) {
          contentReplacementRecords.push(
            ...(replacements as ContentReplacementEntry['replacements']),
          )
        }
        continue
      }
      if (
        !isTranscriptMessage(rec as TranscriptMessage) ||
        (rec as TranscriptMessage).isSidechain
      ) {
        continue
      }
      const original = rec as TranscriptMessage
      const forkedEntry: TranscriptEntry = {
        ...original,
        sessionId: forkSessionId,
        parentUuid,
        isSidechain: false,
        forkedFrom: {
          sessionId: originalSessionId,
          messageUuid: original.uuid,
        },
      }
      serializedMessages.push({
        ...original,
        sessionId: forkSessionId,
      })
      lastOriginal = original
      await writeLine(jsonStringify(forkedEntry) + '\n')
      if (original.type !== 'progress') {
        parentUuid = original.uuid
      }
    }
  } catch (error) {
    await cleanup()
    throw error
  } finally {
    rl.close()
    input.destroy()
  }

  if (lastOriginal === null) {
    await cleanup()
    throw new Error('No messages to branch')
  }

  if (extraMessages?.length) {
    for (const extra of extraMessages) {
      const stamped: TranscriptMessage = {
        ...extra,
        cwd: lastOriginal.cwd,
        userType: lastOriginal.userType,
        entrypoint: lastOriginal.entrypoint,
        version: lastOriginal.version,
        gitBranch: lastOriginal.gitBranch,
        sessionId: forkSessionId,
        timestamp: new Date().toISOString(),
      }
      const forked: TranscriptEntry = {
        ...stamped,
        parentUuid,
        isSidechain: false,
      }
      serializedMessages.push(stamped)
      await writeLine(jsonStringify(forked) + '\n')
      if (extra.type !== 'progress') {
        parentUuid = extra.uuid
      }
    }
  }

  if (contentReplacementRecords.length > 0) {
    const forkedReplacementEntry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: forkSessionId,
      replacements: contentReplacementRecords,
    }
    await writeLine(jsonStringify(forkedReplacementEntry) + '\n')
  }

  output.end()
  await finished(output).catch(() => {})
  if (writeError) {
    await cleanup()
    throw writeError
  }

  return {
    sessionId: forkSessionId,
    title: customTitle,
    forkPath: forkSessionPath,
    serializedMessages,
    contentReplacementRecords,
  }
}

/**
 * Generates a unique fork name by checking for collisions with existing session names.
 * If "baseName (Branch)" already exists, tries "baseName (Branch 2)", "baseName (Branch 3)", etc.
 */
async function getUniqueForkName(baseName: string): Promise<string> {
  const candidateName = `${baseName} (Branch)`

  // Check if this exact name already exists
  const existingWithExactName = await searchSessionsByCustomTitle(
    candidateName,
    { exact: true },
  )

  if (existingWithExactName.length === 0) {
    return candidateName
  }

  // Name collision - find a unique numbered suffix
  // Search for all sessions that start with the base pattern
  const existingForks = await searchSessionsByCustomTitle(`${baseName} (Branch`)

  // Extract existing fork numbers to find the next available
  const usedNumbers = new Set<number>([1]) // Consider " (Branch)" as number 1
  const forkNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const session of existingForks) {
    const match = session.customTitle?.match(forkNumberPattern)
    if (match) {
      if (match[1]) {
        usedNumbers.add(parseInt(match[1], 10))
      } else {
        usedNumbers.add(1) // " (Branch)" without number is treated as 1
      }
    }
  }

  // Find the next available number
  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }

  return `${baseName} (Branch ${nextNumber})`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const customTitle = args?.trim() || undefined

  const originalSessionId = getSessionId()

  try {
    const {
      sessionId,
      title,
      forkPath,
      serializedMessages,
      contentReplacementRecords,
    } = await createFork(customTitle)

    // Build LogOption for resume
    const now = new Date()
    const firstPrompt = deriveFirstPrompt(
      serializedMessages.find(m => m.type === 'user'),
    )

    // Save custom title - use provided title or firstPrompt as default
    // This ensures /status and /resume show the same session name
    // Always add " (Branch)" suffix to make it clear this is a branched session
    // Handle collisions by adding a number suffix (e.g., " (Branch 2)", " (Branch 3)")
    const baseName = title ?? firstPrompt
    const effectiveTitle = await getUniqueForkName(baseName)
    await saveCustomTitle(sessionId, effectiveTitle, forkPath)

    logEvent('tengu_conversation_forked', {
      message_count: serializedMessages.length,
      has_custom_title: !!title,
    })

    const forkLog: LogOption = {
      date: now.toISOString().split('T')[0]!,
      messages: serializedMessages,
      fullPath: forkPath,
      value: now.getTime(),
      created: now,
      modified: now,
      firstPrompt,
      messageCount: serializedMessages.length,
      isSidechain: false,
      sessionId,
      customTitle: effectiveTitle,
      contentReplacements: contentReplacementRecords,
    }

    // Resume into the fork
    const titleInfo = title ? ` "${effectiveTitle}"` : ''
    const resumeHint = `\nTo return to the original: /resume ${originalSessionId}\n(or from a new terminal: claude -r ${originalSessionId})`
    const successMessage = `Branched conversation${titleInfo}. You are now in the branch.${resumeHint}`

    if (context.resume) {
      await context.resume(sessionId, forkLog, 'fork')
      onDone(successMessage, { display: 'system' })
    } else {
      // Fallback if resume not available
      onDone(
        `Branched conversation${titleInfo}. Resume with: /resume ${sessionId}`,
      )
    }

    return null
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`Failed to branch conversation: ${message}`)
    return null
  }
}
