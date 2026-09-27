/**
 * If the first line of a bash command is a `# comment` (not a `#!` shebang),
 * return the comment text stripped of the `#` prefix. Otherwise undefined.
 *
 * Official 2.1.113 QC_: a first-line comment is only used as the transcript
 * label when the rest of the command is empty or more comments. If any later
 * line is a real command, return undefined so the UI shows the full command
 * (closes the `# innocuous\nrm -rf /` spoofing vector). Control characters
 * in the comment also suppress the label.
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  if (nl !== -1 && restHasNonCommentContent(command.slice(nl + 1))) {
    return undefined
  }
  const text = firstLine.replace(/^#+\s*/, '')
  if (!text || hasControlChars(text)) return undefined
  return text
}

function restHasNonCommentContent(rest: string): boolean {
  for (const line of rest.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue
    return true
  }
  return false
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 || (code >= 127 && code <= 159)) return true
  }
  return false
}
