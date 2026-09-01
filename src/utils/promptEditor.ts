import { spawnSync } from 'child_process'
import {
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
} from '../history.js'
import instances from '../ink/instances.js'
import type { PastedContent } from './config.js'
import { classifyGuiEditor, getExternalEditor } from './editor.js'
import { getFsImplementation } from './fsOperations.js'
import { toIDEDisplayName } from './ide.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'
import { generateTempFilePath } from './tempfile.js'
import { extractTextContent } from './messages.js'
import type { Message } from '../types/message.js'

// Map of editor command overrides (e.g., to add wait flags)
const EDITOR_OVERRIDES: Record<string, string> = {
  code: 'code -w', // VS Code: wait for file to be closed
  subl: 'subl --wait', // Sublime Text: wait for file to be closed
}

function isGuiEditor(editor: string): boolean {
  return classifyGuiEditor(editor) !== undefined
}

export type EditorResult = {
  content: string | null
  error?: string
}

// sync IO: called from sync context (React components, sync command handlers)
export function editFileInEditor(filePath: string): EditorResult {
  const fs = getFsImplementation()
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    throw new Error('Ink instance not found - cannot pause rendering')
  }

  const editor = getExternalEditor()
  if (!editor) {
    return { content: null }
  }

  try {
    fs.statSync(filePath)
  } catch {
    return { content: null }
  }

  const useAlternateScreen = !isGuiEditor(editor)

  if (useAlternateScreen) {
    // Terminal editors (vi, nano, etc.) take over the terminal. Delegate to
    // Ink's alt-screen-aware handoff so fullscreen mode (where <AlternateScreen>
    // already entered alt screen) doesn't get knocked back to the main buffer
    // by a hardcoded ?1049l. enterAlternateScreen() internally calls pause()
    // and suspendStdin(); exitAlternateScreen() undoes both and resets frame
    // state so the next render writes from scratch.
    inkInstance.enterAlternateScreen()
  } else {
    // GUI editors (code, subl, etc.) open in a separate window — just pause
    // Ink and release stdin while they're open.
    inkInstance.pause()
    inkInstance.suspendStdin()
  }

  try {
    // Use override command if available, otherwise use the editor as-is
    const editorCommand = EDITOR_OVERRIDES[editor] ?? editor
    const parts = editorCommand.split(' ')
    const base = parts[0] ?? editorCommand
    const editorArgs = parts.slice(1)
    // Official 110: POSIX spawnSync argv (no shell) so untrusted filenames
    // cannot inject. win32 still needs shell:true for .cmd / start.
    let result
    if (process.platform === 'win32') {
      result = spawnSync(`${editorCommand} "${filePath}"`, {
        stdio: 'inherit',
        shell: true,
      })
    } else {
      result = spawnSync(base, [...editorArgs, filePath], {
        stdio: 'inherit',
      })
    }
    if (
      result.error ||
      result.signal ||
      (result.status !== null && result.status !== 0)
    ) {
      const editorName = toIDEDisplayName(editor)
      const detail = result.error
        ? result.error.message
        : result.signal
          ? `terminated by signal ${result.signal}`
          : `exited with code ${result.status}`
      return { content: null, error: `${editorName} ${detail}` }
    }

    // Read the edited content
    const editedContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
    return { content: editedContent }
  } catch {
    return { content: null }
  } finally {
    if (useAlternateScreen) {
      inkInstance.exitAlternateScreen()
    } else {
      inkInstance.resumeStdin()
      inkInstance.resume()
    }
  }
}

/**
 * Re-collapse expanded pasted text by finding content that matches
 * pastedContents and replacing it with references.
 */
function recollapsePastedContent(
  editedPrompt: string,
  originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let collapsed = editedPrompt

  // Find pasted content in the edited text and re-collapse it
  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'text') {
      const pasteId = parseInt(id)
      const contentStr = content.content

      // Check if this exact content exists in the edited prompt
      const contentIndex = collapsed.indexOf(contentStr)
      if (contentIndex !== -1) {
        // Replace with reference
        const numLines = getPastedTextRefNumLines(contentStr)
        const ref = formatPastedTextRef(pasteId, numLines)
        collapsed =
          collapsed.slice(0, contentIndex) +
          ref +
          collapsed.slice(contentIndex + contentStr.length)
      }
    }
  }

  return collapsed
}

const LAST_RESPONSE_DIVIDER =
  '# ─── Write your reply below this line ──────────────────────────'
const LAST_RESPONSE_MAX_LINES = 50

/** Official DSK: last N assistant text turns, capped by byte length. */
export function collectLastAssistantResponses(
  messages: readonly Message[],
  maxMessages = 8,
  maxBytes = 65536,
): { messages: string[]; capped: boolean } {
  const collected: string[] = []
  let bytes = 0
  let capped = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'assistant') {
      const content = msg.message.content
      const text = (
        typeof content === 'string'
          ? content
          : extractTextContent(content, '\n')
      ).trim()
      if (!text) continue
      const size = Buffer.byteLength(text, 'utf8')
      if (
        collected.length >= maxMessages ||
        (collected.length > 0 && bytes + size > maxBytes)
      ) {
        capped = true
        break
      }
      collected.push(text)
      bytes += size
    } else if (msg.type === 'user') {
      const content = msg.message.content
      if (typeof content !== 'string' && content.some(b => b.type === 'tool_result')) {
        continue
      }
      if (msg.isMeta) continue
      break
    }
  }
  collected.reverse()
  return { messages: collected, capped }
}

/** Official SSY: comment-wrap last response for the external editor. */
function wrapLastResponseContext(text: string): string {
  let lines = text.split('\n')
  if (lines.length > LAST_RESPONSE_MAX_LINES) {
    lines = lines.slice(-LAST_RESPONSE_MAX_LINES)
    lines.unshift('… (earlier output truncated)')
  }
  return (
    `# ─── Claude's last response (for reference; removed on save) ───\n` +
    `${lines.map(line => (line ? `# ${line}` : '#')).join('\n')}\n` +
    `${LAST_RESPONSE_DIVIDER}\n\n`
  )
}

/** Official CSY: strip the commented last-response preamble on save. */
function unwrapLastResponseContext(text: string): string {
  const idx = text.indexOf(LAST_RESPONSE_DIVIDER)
  if (idx === -1) return text
  return text.slice(idx + LAST_RESPONSE_DIVIDER.length).replace(/^\r?\n\r?\n?/, '')
}

// sync IO: called from sync context (React components, sync command handlers)
export function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
  lastResponseContext?: string,
): EditorResult {
  const fs = getFsImplementation()
  const tempFile = generateTempFilePath()

  try {
    // Expand any pasted text references before editing
    const expandedPrompt = pastedContents
      ? expandPastedTextRefs(currentPrompt, pastedContents)
      : currentPrompt

    const toWrite = lastResponseContext
      ? wrapLastResponseContext(lastResponseContext) + expandedPrompt
      : expandedPrompt

    // Write expanded prompt to temp file
    writeFileSync_DEPRECATED(tempFile, toWrite, {
      encoding: 'utf-8',
      flush: true,
    })

    // Delegate to editFileInEditor
    const result = editFileInEditor(tempFile)

    if (result.content === null) {
      return result
    }

    let finalContent = result.content
    if (lastResponseContext) {
      finalContent = unwrapLastResponseContext(finalContent)
    }

    // Trim a single trailing newline if present (common editor behavior)
    if (finalContent.endsWith('\n') && !finalContent.endsWith('\n\n')) {
      finalContent = finalContent.slice(0, -1)
    }

    // Re-collapse pasted content if it wasn't edited
    if (pastedContents) {
      finalContent = recollapsePastedContent(
        finalContent,
        currentPrompt,
        pastedContents,
      )
    }

    return { content: finalContent }
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}
