/**
 * Official 2.1.154 Discover pin — `wk8` (parse relevance) + `Dk8` (cwd/cli/hosts/filesRead/manifestDep match).
 */

import { stat, readFile } from 'fs/promises'
import picomatch from 'picomatch'
import { logForDebugging } from '../../utils/debug.js'
import { getCwd } from '../../utils/cwd.js'
import { cacheKeys, type FileStateCache } from '../../utils/fileStateCache.js'
import { findGitRoot } from '../../utils/git.js'
import { withTimeout } from '../../utils/sleep.js'

const MANIFEST_DEP_MAX_BYTES = 524288
const MANIFEST_DEP_SCAN_TIMEOUT_MS = 50

export type DiscoverRelevanceSignals = {
  cli?: string[]
  hosts?: string[]
  filesRead?: string[]
  manifestDep?: Array<{ file: RegExp; pattern: RegExp }>
  cwd?: string[]
}

export type DiscoverMatchContext = {
  bashTools?: Set<string>
  bashHosts?: Set<string>
  readFileState?: FileStateCache
}

type RawRelevance = {
  signals?: {
    cli?: string[]
    hosts?: string[]
    filesRead?: string[]
    manifestDeps?: Array<{ file: string; pattern: string }>
    cwd?: string[]
  }
}

/**
 * Official 2.1.154 `wk8`.
 * Returns null unless cli / filesRead / manifestDeps / hosts / cwd signals exist.
 */
export function parseDiscoverRelevanceSignals(
  pluginName: string,
  relevance: RawRelevance | undefined,
): DiscoverRelevanceSignals | null {
  const raw = relevance
  if (
    !raw?.signals ||
    (!raw.signals.cli?.length &&
      !raw.signals.filesRead?.length &&
      !raw.signals.manifestDeps?.length &&
      !raw.signals.hosts?.length &&
      !raw.signals.cwd?.length)
  ) {
    return null
  }
  let manifestDep: Array<{ file: RegExp; pattern: RegExp }> | undefined
  try {
    if (raw.signals.manifestDeps?.length) {
      manifestDep = raw.signals.manifestDeps.map(dep => ({
        file: new RegExp(dep.file, 'i'),
        pattern: new RegExp(dep.pattern),
      }))
    }
  } catch (error) {
    logForDebugging(
      `Skipping relevance signals for "${pluginName}": invalid RegExp in relevance.signals: ${error}`,
      { level: 'warn' },
    )
    return null
  }
  const hosts = raw.signals.hosts?.map(host => host.toLowerCase())
  return {
    cli: raw.signals.cli,
    hosts,
    filesRead: raw.signals.filesRead,
    manifestDep,
    cwd: raw.signals.cwd,
  }
}

/**
 * Official 2.1.154 `Dk8`.
 * Discover load passes `undefined` context — only cwd can match there.
 */
export async function matchDiscoverRelevance(
  signals: DiscoverRelevanceSignals,
  context?: DiscoverMatchContext,
): Promise<boolean> {
  const { bashTools, bashHosts } = context ?? {}
  if (signals.cli && bashTools?.size) {
    if (signals.cli.some(cmd => bashTools.has(cmd))) {
      return true
    }
  }
  if (signals.hosts?.length && bashHosts?.size) {
    if (signals.hosts.some(host => bashHosts.has(host))) {
      return true
    }
  }
  if (signals.cwd?.length) {
    const abs = getCwd().replaceAll('\\', '/')
    const gitRoot = findGitRoot(getCwd())?.replaceAll('\\', '/')
    const candidates = [abs]
    if (gitRoot && abs.startsWith(`${gitRoot}/`)) {
      candidates.push(abs.slice(gitRoot.length + 1))
    }
    for (const raw of signals.cwd) {
      const pattern = raw.replace(/\/+$/, '').replace(/\/\*\*$/, '')
      if (!pattern) continue
      if (
        candidates.some(path =>
          picomatch.isMatch(path, [pattern, `${pattern}/**`], {
            nocase: true,
            dot: true,
          }),
        )
      ) {
        return true
      }
    }
  }
  const readFileState = context?.readFileState
  const readFiles = readFileState ? cacheKeys(readFileState) : []
  if (signals.filesRead?.length && readFiles.length) {
    if (
      readFiles
        .map(fp => fp.replaceAll('\\', '/'))
        .some(fp =>
          picomatch.isMatch(fp, signals.filesRead!, {
            nocase: true,
            dot: true,
          }),
        )
    ) {
      return true
    }
  }
  if (signals.manifestDep && readFileState && readFiles.length > 0) {
    const entries = new Map(readFileState.entries())
    const scan = (async () => {
      for (const { file, pattern } of signals.manifestDep!) {
        for (const path of readFiles) {
          if (!file.test(path)) continue
          try {
            const cached = entries.get(path)
            let content =
              cached &&
              cached.limit === undefined &&
              (cached.offset ?? 1) <= 1 &&
              !cached.isPartialView
                ? cached.content
                : undefined
            if (!content) {
              if ((await stat(path)).size > MANIFEST_DEP_MAX_BYTES) continue
              content = await readFile(path, 'utf8')
            }
            if (pattern.test(content)) return true
          } catch {
            // skip unreadable files
          }
        }
      }
      return false
    })()
    const hit = await withTimeout(
      scan,
      MANIFEST_DEP_SCAN_TIMEOUT_MS,
      'manifestDep scan',
    ).catch(() => false)
    if (hit) return true
  }
  return false
}
