/**
 * `claude project purge` — Official 2.1.126 `bb5` / `purgeProjectHandler`.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { createReadStream } from 'fs'
import { readdir, rm, stat, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { createInterface } from 'readline'
import React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Box, render, Text } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { deleteProjectConfig, getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import {
  canonicalizePath,
  MAX_SANITIZED_LENGTH,
  sanitizePath,
} from '../../utils/sessionStoragePortable.js'
import { getProjectDir, getProjectsDir } from '../../utils/sessionStorage.js'
import { getTasksDir } from '../../utils/tasks.js'
import { cliError, cliOk } from '../exit.js'

const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PurgeItemKind = 'config-key' | 'history-lines' | 'file' | 'dir'

export type PurgeItem = {
  path: string
  kind: PurgeItemKind
  reason: string
  matchPaths?: Set<string>
}

export type PurgeOptions = {
  dryRun?: boolean
  yes?: boolean
  interactive?: boolean
  all?: boolean
}

function writeLine(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function warnLine(line: string): void {
  process.stderr.write(`${line}\n`)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function confirmYesNo(prompt: string): Promise<boolean> {
  let resolveConfirm: (value: boolean) => void = () => {}
  const done = new Promise<boolean>(resolve => {
    resolveConfirm = resolve
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question(`${prompt} [y/N] `, answer => {
    rl.close()
    const normalized = answer.trim().toLowerCase()
    resolveConfirm(normalized === 'y' || normalized === 'yes')
  })
  return done
}

async function promptSelect<T>(
  title: string,
  options: Array<{ label: string; value: T; description?: string }>,
  defaultValue?: T,
): Promise<T | null> {
  let resolveValue: (value: T | null) => void = () => {}
  const done = new Promise<T | null>(resolve => {
    resolveValue = resolve
  })
  const { unmount, waitUntilExit } = await render(
    React.createElement(
      AppStateProvider,
      null,
      React.createElement(
        KeybindingSetup,
        null,
        React.createElement(
          Box,
          { flexDirection: 'column', gap: 1, paddingY: 1 },
          React.createElement(Text, { bold: true }, title),
          React.createElement(Select, {
            options,
            defaultValue,
            visibleOptionCount: 10,
            onChange: (value: T) => {
              resolveValue(value)
              unmount()
            },
            onCancel: () => {
              resolveValue(null)
              unmount()
            },
          }),
        ),
      ),
    ),
    { exitOnCtrlC: false },
  )
  await waitUntilExit()
  return done
}

function projectConfigKeys(): string[] {
  return Object.keys(getGlobalConfig().projects ?? {})
}

async function selectProjectToPurge(): Promise<string | null> {
  const current = resolve(getCwd())
  const seen = new Set([current])
  const options: Array<{ label: string; value: string; description?: string }> =
    [{ label: current, value: current, description: 'current directory' }]
  for (const key of projectConfigKeys()) {
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ label: key, value: key })
  }
  return promptSelect('Select a project to purge:', options, current)
}

function pathIsUnder(path: string, roots: Iterable<string>): boolean {
  for (const root of roots) {
    if (path === root || path.startsWith(root + sep)) {
      return true
    }
  }
  return false
}

function historyLineMatchesProject(
  line: string,
  matchPaths: Set<string>,
): boolean {
  if (!line) return false
  try {
    const parsed = safeParseJSON(line)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'project' in parsed &&
      typeof (parsed as { project?: unknown }).project === 'string' &&
      pathIsUnder((parsed as { project: string }).project, matchPaths)
    )
  } catch {
    return false
  }
}

async function transcriptDirMatchesProject(
  dir: string,
  matchPaths: Set<string>,
): Promise<boolean> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort()
  } catch {
    return false
  }
  for (const name of names) {
    const stream = createReadStream(join(dir, name), { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let n = 0
    try {
      for await (const line of rl) {
        if (++n > 50) break
        try {
          const parsed = safeParseJSON(line)
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'cwd' in parsed &&
            typeof (parsed as { cwd?: unknown }).cwd === 'string'
          ) {
            return pathIsUnder((parsed as { cwd: string }).cwd, matchPaths)
          }
        } catch {
          // skip malformed transcript lines
        }
      }
    } catch {
      // skip unreadable transcript
    } finally {
      rl.close()
      stream.close()
    }
  }
  return false
}

/** Official 2.1.126 `zp6` / `scanHistoryFile`. */
export async function scanHistoryFile(
  historyPath: string,
  matchPaths: Set<string>,
  mode: 'count' | 'filter',
): Promise<number> {
  const rl = createInterface({
    input: createReadStream(historyPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const kept: string[] = []
  let matched = 0
  try {
    for await (const line of rl) {
      if (historyLineMatchesProject(line, matchPaths)) {
        matched++
      } else if (mode === 'filter') {
        kept.push(line)
      }
    }
  } catch (error) {
    if (isENOENT(error)) return 0
    throw error
  }
  if (mode === 'filter' && matched > 0) {
    await writeFile(historyPath, kept.length ? `${kept.join('\n')}\n` : '')
  }
  return matched
}

async function sessionIdsInProjectDir(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -6))
    .filter(id => SESSION_UUID_RE.test(id))
}

/** Official 2.1.126 `t2` — existing project session dirs for a cwd. */
async function projectSessionDirsFor(cwd: string): Promise<string[]> {
  const exact = getProjectDir(cwd)
  const found: string[] = []
  try {
    await readdir(exact)
    found.push(exact)
  } catch {
    // no exact session dir
  }
  const sanitized = sanitizePath(cwd)
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return found
  }
  const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH) + '-'
  const projectsDir = getProjectsDir()
  try {
    for (const dirent of await readdir(projectsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !dirent.name.startsWith(prefix)) continue
      const full = join(projectsDir, dirent.name)
      if (full !== exact) found.push(full)
    }
  } catch {
    // projects dir missing
  }
  return found
}

function normalizeConfigKey(path: string): string {
  return normalizePathForConfigKey(path).replace(/\/+$/, '') || '/'
}

async function collectPurgeItemsForProject(
  targetPath: string,
): Promise<{ items: PurgeItem[]; warnings: string[] }> {
  const configHome = getClaudeConfigHomeDir()
  const resolved = resolve(targetPath)
  const canonical = await canonicalizePath(resolved)
  const matchPaths = new Set([resolved, canonical])
  const projectDirKeys: string[] = []
  try {
    await stat(resolved)
    for (const p of matchPaths) {
      const dir = getProjectDir(p)
      if (dir) projectDirKeys.push(dir)
    }
  } catch {
    // target path may not exist on disk
  }

  const items: PurgeItem[] = []
  const warnings: string[] = []
  const sessionDirs = new Set<string>()
  for (const p of matchPaths) {
    for (const dir of await projectSessionDirsFor(p)) {
      sessionDirs.add(dir)
    }
  }

  const projectsDir = getProjectsDir()
  const prefixes = [...matchPaths].map(p => sanitizePath(p) + '-')
  try {
    for (const dirent of await readdir(projectsDir, { withFileTypes: true })) {
      const full = join(projectsDir, dirent.name)
      if (
        dirent.isDirectory() &&
        !sessionDirs.has(full) &&
        prefixes.some(prefix => dirent.name.startsWith(prefix)) &&
        (await transcriptDirMatchesProject(full, matchPaths))
      ) {
        sessionDirs.add(full)
      }
    }
  } catch {
    // no projects dir
  }

  const sessionIds = new Set<string>()
  for (const dir of sessionDirs) {
    for (const id of await sessionIdsInProjectDir(dir)) {
      sessionIds.add(id)
    }
  }

  for (const id of sessionIds) {
    const tasksDir = getTasksDir(id)
    if (await pathExists(tasksDir)) {
      items.push({
        path: tasksDir,
        kind: 'dir',
        reason: `tasks for session ${id}`,
      })
    }
    const debugLog = join(configHome, 'debug', `${id}.txt`)
    if (await pathExists(debugLog)) {
      items.push({
        path: debugLog,
        kind: 'file',
        reason: `debug log for session ${id}`,
      })
    }
    const fileHistory = join(configHome, 'file-history', id)
    if (await pathExists(fileHistory)) {
      items.push({
        path: fileHistory,
        kind: 'dir',
        reason: `file edit history for session ${id}`,
      })
    }
  }

  for (const dir of sessionDirs) {
    items.push({
      path: dir,
      kind: 'dir',
      reason: 'project transcripts (.jsonl) and memory/',
    })
  }

  const config = getGlobalConfig()
  const configKeys = new Set(
    [...matchPaths, ...projectDirKeys].map(normalizeConfigKey),
  )
  for (const key of Object.keys(config.projects ?? {})) {
    if (configKeys.has(normalizeConfigKey(key))) {
      items.push({
        path: key,
        kind: 'config-key',
        reason:
          'project entry in ~/.claude.json (trust, history, MCP servers)',
      })
    }
  }

  const historyPath = join(configHome, 'history.jsonl')
  const historyHits = await scanHistoryFile(historyPath, matchPaths, 'count')
  if (historyHits > 0) {
    items.push({
      path: historyPath,
      kind: 'history-lines',
      reason: `${historyHits} prompt(s) typed in this project`,
      matchPaths,
    })
  }

  if (await pathExists(join(configHome, 'shell-snapshots'))) {
    warnings.push(
      'shell-snapshots/ are not project-scoped and will not be touched',
    )
  }
  const backups = join(configHome, 'backups')
  if (await pathExists(backups)) {
    warnings.push(
      `backups/ may still contain this project entry in old .claude.json snapshots (${backups}); at most 5 are kept and they rotate out automatically`,
    )
  }
  return { items, warnings }
}

async function collectPurgeItemsForAll(): Promise<{
  items: PurgeItem[]
  warnings: string[]
}> {
  const configHome = getClaudeConfigHomeDir()
  const items: PurgeItem[] = []
  const warnings: string[] = []
  const dirs: Array<[string, string]> = [
    ['projects', 'all project transcripts (.jsonl) and memory/'],
    ['tasks', 'all session task lists'],
    ['debug', 'all session debug logs'],
    ['file-history', 'all session file edit history'],
  ]
  for (const [name, reason] of dirs) {
    const p = join(configHome, name)
    if (await pathExists(p)) {
      items.push({ path: p, kind: 'dir', reason })
    }
  }
  const historyPath = join(configHome, 'history.jsonl')
  if (await pathExists(historyPath)) {
    items.push({
      path: historyPath,
      kind: 'file',
      reason: 'prompt history across all projects',
    })
  }
  for (const key of projectConfigKeys()) {
    items.push({
      path: key,
      kind: 'config-key',
      reason: 'project entry in ~/.claude.json (trust, history, MCP servers)',
    })
  }
  if (await pathExists(join(configHome, 'shell-snapshots'))) {
    warnings.push(
      'shell-snapshots/ are not project-scoped and will not be touched',
    )
  }
  const backups = join(configHome, 'backups')
  if (await pathExists(backups)) {
    warnings.push(
      `backups/ may still contain project entries in old .claude.json snapshots (${backups}); at most 5 are kept and they rotate out automatically`,
    )
  }
  return { items, warnings }
}

async function applyPurgeItem(item: PurgeItem): Promise<void> {
  switch (item.kind) {
    case 'config-key':
      deleteProjectConfig(item.path)
      return
    case 'history-lines':
      await scanHistoryFile(
        item.path,
        item.matchPaths ?? new Set(),
        'filter',
      )
      return
    case 'file':
    case 'dir':
      await rm(item.path, { recursive: item.kind === 'dir', force: true })
      return
  }
}

function formatPurgeItem(item: PurgeItem): string {
  let head: string
  switch (item.kind) {
    case 'config-key':
      head = `config: projects["${item.path}"]`
      break
    case 'history-lines':
      head = `filter: ${item.path}`
      break
    case 'file':
    case 'dir':
      head = `${item.kind}:    ${item.path}`
      break
  }
  return `${head}\n           ${item.reason}`
}

function printPurgePlan(
  label: string,
  items: PurgeItem[],
  warnings: string[],
): void {
  writeLine(`\nPurge plan for ${label}:\n`)
  for (const item of items) {
    writeLine(`  ${formatPurgeItem(item)}`)
  }
  if (warnings.length) {
    writeLine()
    for (const warning of warnings) {
      warnLine(warning)
    }
  }
}

/** Official 2.1.126 `bb5` / `purgeProjectHandler`. */
export async function purgeProjectHandler(
  pathArg: string | undefined,
  options: PurgeOptions,
): Promise<void> {
  if (options.all) {
    if (pathArg) {
      return cliError('Cannot specify both a path and --all.')
    }
    if (options.interactive) {
      return cliError('Cannot use -i/--interactive with --all.')
    }
    const { items, warnings } = await collectPurgeItemsForAll()
    if (items.length === 0) {
      return cliError(
        `No Claude Code project state found under ${getClaudeConfigHomeDir()}.`,
      )
    }
    printPurgePlan('all projects', items, warnings)
    if (options.dryRun) {
      return cliOk(
        `Dry run: ${items.length} item(s) would be deleted.`,
      )
    }
    if (!options.yes) {
      if (
        !(await confirmYesNo(
          `Delete ${items.length} item(s) for ALL projects? This cannot be undone.`,
        ))
      ) {
        return cliError('Aborted.')
      }
    }
    for (const item of items) {
      await applyPurgeItem(item)
    }
    return cliOk(`Purged ${items.length} item(s) across all projects.`)
  }

  let target: string
  if (pathArg) {
    target = resolve(pathArg)
  } else {
    const selected = await selectProjectToPurge()
    if (selected === null) {
      return cliError('Aborted.')
    }
    target = selected
  }

  const { items, warnings } = await collectPurgeItemsForProject(target)
  if (items.length === 0) {
    return cliError(
      `No Claude Code project state found for ${target} under ${getClaudeConfigHomeDir()}.`,
    )
  }
  printPurgePlan(target, items, warnings)
  if (options.dryRun) {
    return cliOk(`Dry run: ${items.length} item(s) would be deleted.`)
  }
  if (options.interactive) {
    let deleted = 0
    let deleteRest = false
    for (const [index, item] of items.entries()) {
      let action: 'delete' | 'skip' | 'all' | 'abort' = 'delete'
      if (!deleteRest) {
        action =
          (await promptSelect(
            `[${index + 1}/${items.length}] ${formatPurgeItem(item)}`,
            [
              { label: 'Delete', value: 'delete' },
              { label: 'Skip', value: 'skip' },
              { label: 'Delete this and all remaining', value: 'all' },
              { label: 'Abort', value: 'abort' },
            ],
          )) ?? 'abort'
      }
      if (action === 'abort') {
        return cliError(`Aborted. ${deleted} item(s) deleted.`)
      }
      if (action === 'skip') continue
      if (action === 'all') deleteRest = true
      await applyPurgeItem(item)
      deleted++
    }
    return cliOk(`Purged ${deleted}/${items.length} item(s) for ${target}.`)
  }
  if (!options.yes) {
    if (
      !(await confirmYesNo(
        `Delete ${items.length} item(s) for ${target}? This cannot be undone.`,
      ))
    ) {
      return cliError('Aborted.')
    }
  }
  for (const item of items) {
    await applyPurgeItem(item)
  }
  return cliOk(`Purged ${items.length} item(s) for ${target}.`)
}
