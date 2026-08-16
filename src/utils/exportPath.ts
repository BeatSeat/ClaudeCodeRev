import { mkdirSync } from 'fs'
import { dirname, extname } from 'path'
import { expandPath } from './path.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'

/** Official 2.1.98: only append .txt when the path has no extension. */
export function resolveExportFilePath(filename: string): string {
  const withExt = extname(filename) === '' ? `${filename}.txt` : filename
  return expandPath(withExt)
}

export function writeExportedConversation(
  filename: string,
  content: string,
): string {
  const filepath = resolveExportFilePath(filename)
  mkdirSync(dirname(filepath), { recursive: true })
  writeFileSync_DEPRECATED(filepath, content, {
    encoding: 'utf-8',
    flush: true,
  })
  return filepath
}
