import { readFile } from 'fs/promises'
import { homedir, platform } from 'os'
import { join } from 'path'
import { isFsInaccessible } from '../../utils/errors.js'
import { env } from '../../utils/env.js'
import { safeParseJSONC } from '../../utils/json.js'
import { logError } from '../../utils/log.js'

export const EDITOR_SCROLL_SENSITIVITY_KEY =
  'terminal.integrated.mouseWheelScrollSensitivity'
export const EDITOR_SCROLL_SENSITIVITY = 3

export type EditorKind = 'VSCode' | 'Cursor' | 'Windsurf' | 'Devin Desktop'

export type EditorSensitivity = {
  editor: EditorKind
  sensitivity: number | null
  recommended: number
}

/** Official 139 t46 — skip editor settings on a remote SSH workspace. */
function isVSCodeRemoteSSH(): boolean {
  const askpassMain = process.env.VSCODE_GIT_ASKPASS_MAIN ?? ''
  const path = process.env.PATH ?? ''
  return (
    askpassMain.includes('.vscode-server') ||
    askpassMain.includes('.cursor-server') ||
    askpassMain.includes('.windsurf-server') ||
    askpassMain.includes('.devin-server') ||
    path.includes('.vscode-server') ||
    path.includes('.cursor-server') ||
    path.includes('.windsurf-server') ||
    path.includes('.devin-server')
  )
}

/** Official 139 Up1 */
function detectEditor(): EditorKind | null {
  switch (env.terminal) {
    case 'vscode':
      return 'VSCode'
    case 'cursor':
      return 'Cursor'
    case 'windsurf':
      return 'Devin Desktop'
    default:
      return null
  }
}

/** Official 139 _96 */
function getEditorUserDir(editor: EditorKind): string {
  const editorDir = editor === 'VSCode' ? 'Code' : editor
  return join(
    homedir(),
    platform() === 'win32'
      ? join('AppData', 'Roaming', editorDir, 'User')
      : platform() === 'darwin'
        ? join('Library', 'Application Support', editorDir, 'User')
        : join('.config', editorDir, 'User'),
  )
}

/** Official 139 yL5 */
export function editorSensitivityLabel(info: EditorSensitivity): string {
  const name = info.editor === 'VSCode' ? 'VS Code' : info.editor
  if (info.sensitivity === null) {
    return `${name} wheel sensitivity unset · /terminal-setup sets it to ${info.recommended}`
  }
  if (info.sensitivity >= info.recommended) {
    return `${name} wheel sensitivity ${info.sensitivity}`
  }
  return `${name} wheel sensitivity ${info.sensitivity} · /terminal-setup raises it to ${info.recommended}`
}

/** Official 139 K96 — read the editor's mouseWheelScrollSensitivity. */
export async function readEditorWheelSensitivity(): Promise<EditorSensitivity | null> {
  const editor = detectEditor()
  if (!editor || isVSCodeRemoteSSH()) return null
  try {
    const raw = await readFile(
      join(getEditorUserDir(editor), 'settings.json'),
      { encoding: 'utf-8' },
    )
    const parsed = safeParseJSONC(raw)
    const value =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)[EDITOR_SCROLL_SENSITIVITY_KEY]
        : undefined
    return {
      editor,
      sensitivity: typeof value === 'number' ? value : null,
      recommended: EDITOR_SCROLL_SENSITIVITY,
    }
  } catch (e) {
    if (!isFsInaccessible(e)) logError(e)
    return {
      editor,
      sensitivity: null,
      recommended: EDITOR_SCROLL_SENSITIVITY,
    }
  }
}
