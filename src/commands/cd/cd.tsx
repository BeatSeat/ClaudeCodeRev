import chalk from 'chalk'
import figures from 'figures'
import * as React from 'react'
import { useEffect } from 'react'
import { stat, realpath } from 'fs/promises'
import { dirname, parse } from 'path'
import {
  getCwdState,
  getSessionId,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { ConfirmDialog } from '../../components/ConfirmDialog.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Box, Link, Text } from '../../ink.js'
import {
  getErrnoCode,
} from '../../utils/errors.js'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { isPathTrusted, markPathTrusted } from '../../utils/config.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import { getCwd } from '../../utils/cwd.js'
import { getIsGit } from '../../utils/git.js'
import { reanchorGitFileWatcher } from '../../utils/git/gitFilesystem.js'
import { setCwd } from '../../utils/Shell.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { relocateSessionTranscript } from '../../utils/sessionStorage.js'
import {
  getClaudeMds,
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  type MemoryFileInfo,
} from '../../utils/claudemd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { expandPath } from '../../utils/path.js'
import { checkCdPermission } from '../../utils/permissions/cdPermission.js'
import type { PermissionRule } from '../../utils/permissions/PermissionRule.js'
import { getSettingSourceDisplayNameLowercase } from '../../utils/settings/constants.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

function CdError({
  message,
  args,
  onDone,
}: {
  message: string
  args: string
  onDone: () => void
}): React.ReactNode {
  useEffect(() => {
    // We need to defer calling onDone to avoid the "return null" bug where
    // the component unmounts before React can render the error message.
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /cd {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  )
}

/**
 * Trust confirmation when the session moves to a directory (or an ancestor
 * of it) that has never been trusted.
 */
export function CdTrustPrompt({
  directory,
  onConfirm,
  onCancel,
}: {
  directory: string
  onConfirm: () => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <PermissionDialog
      color="warning"
      titleColor="warning"
      title="Moving to a new directory:"
    >
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{directory}</Text>
        <Text>
          This session hasn{"'"}t worked here before. Is this a directory you
          created or one you trust?
        </Text>
        <Text>
          Claude Code{"'"}ll be able to read, edit, and execute files here.
        </Text>
        <Text dimColor>
          <Link url="https://code.claude.com/docs/en/security">
            Security guide
          </Link>
        </Text>
        <ConfirmDialog
          confirmLabel="Yes, move here"
          cancelLabel="No, stay put"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint chord="enter" action="confirm" />
            <KeyboardShortcutHint chord="escape" action="cancel" />
          </Byline>
        </Text>
      </Box>
    </PermissionDialog>
  )
}

/**
 * CLAUDE.md hint for the new directory: gather memory files from the new
 * directory and every ancestor that aren't already loaded this session, and
 * format them like the context block so the model immediately has the new
 * directory's instructions.
 */
async function getClaudeMdHintForNewDirectory(
  newDirectory: string,
): Promise<string> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS)) return ''
  const loadedPaths = new Set<string>()
  for (const file of await getMemoryFiles()) {
    loadedPaths.add(normalizeForCompare(file.path))
  }
  const ancestors: string[] = []
  let dir = newDirectory
  while (dir !== parse(dir).root) {
    ancestors.push(dir)
    dir = dirname(dir)
  }
  const files: MemoryFileInfo[] = []
  for (const ancestor of ancestors.reverse()) {
    files.push(
      ...(await getMemoryFilesForNestedDirectory(
        ancestor,
        newDirectory,
        loadedPaths,
      )),
    )
  }
  return getClaudeMds(files)
}

function normalizeForCompare(path: string): string {
  return path
}

function wrapInSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

function escapePathForSystemReminder(path: string): string {
  return path
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
}

/**
 * Perform the move: chdir, sync bootstrap state, relocate the transcript,
 * refresh dependents, and build the user-facing notice + model system
 * reminder. Rolls the chdir back if the transcript relocation fails.
 */
async function performCd(newDirectory: string): Promise<string> {
  const previousCwd = getCwd()
  const sessionId = getSessionId()
  process.chdir(newDirectory)
  setCwd(newDirectory)
  setOriginalCwd(getCwd())
  try {
    await relocateSessionTranscript()
  } catch (error) {
    let rolledBack = false
    try {
      process.chdir(previousCwd)
      rolledBack = true
    } catch (rollbackError) {
      logForDebugging(
        `/cd transcript move failed and rollback chdir failed; completing the move with the transcript left in its previous home: ${rollbackError}`,
        { level: 'error' },
      )
    }
    if (rolledBack) {
      setCwd(previousCwd)
      setOriginalCwd(previousCwd)
      throw error
    }
  }
  // Official 2.1.176 `nIf`: Ll(), OM.cache.clear?.(), zX()?.refreshGitBranch?.()
  reanchorGitFileWatcher()
  getIsGit.cache.clear?.()
  getReplBridgeHandle()?.refreshGitBranch?.()
  SandboxManager.refreshConfig()
  logEvent('tengu_cd_command', {})
  const claudeMdHint = await getClaudeMdHintForNewDirectory(newDirectory)
  const escapedPath = escapePathForSystemReminder(newDirectory)
  const notice = wrapInSystemReminder(
    `The session's working directory has changed to ${escapedPath} (via /cd). The environment block at the start of this conversation still names the ` +
      'previous directory — that information is stale. All tool calls and ' +
      `relative paths now resolve from ${escapedPath}.`,
  )
  return claudeMdHint ? `${notice}\n\n${claudeMdHint}` : notice
}

/**
 * Build the denial message for a non-allowed Cd check result (Official
 * 2.1.169 `c2f`).
 */
function formatCdDenial(
  directory: string,
  check:
    | { result: 'blockedByRule'; rule: PermissionRule }
    | { result: 'outsideAllowedPatterns'; allowedPatterns: string[] },
): string {
  if (check.result === 'blockedByRule') {
    const ruleDisplay = permissionRuleDisplay(check.rule)
    const sourceDisplay = getSettingSourceDisplayNameLowercase(
      check.rule.source,
    )
    if (check.rule.ruleValue.ruleContent === undefined) {
      return `Can't move to ${chalk.bold(directory)} — /cd is turned off by the ${chalk.bold(ruleDisplay)} rule in ${sourceDisplay}. Update the rule in /permissions to move between directories again.`
    }
    return `Can't move to ${chalk.bold(directory)} — it's excluded by the ${chalk.bold(ruleDisplay)} rule in ${sourceDisplay}. Pick a directory outside that rule, or update it in /permissions.`
  }
  return `Can't move to ${chalk.bold(directory)} — /cd is limited to directories matching ${check.allowedPatterns.map(pattern => chalk.bold(pattern)).join(', ')}. Pick a matching directory, or add a Cd rule in /permissions.`
}

function permissionRuleDisplay(rule: PermissionRule): string {
  const { toolName, ruleContent } = rule.ruleValue
  return ruleContent === undefined ? toolName : `${toolName}(${ruleContent})`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const requested = (args ?? '').trim()
  if (!requested) {
    return (
      <CdError
        message="Usage: /cd <path>"
        args=""
        onDone={() => onDone('Usage: /cd <path>')}
      />
    )
  }

  const requestedPath = expandPath(requested)
  try {
    if (!(await stat(requestedPath)).isDirectory()) {
      const message = `${chalk.bold(requestedPath)} is not a directory. Did you mean ${chalk.bold(dirname(requestedPath))}?`
      return (
        <CdError
          message={message}
          args={requested}
          onDone={() => onDone(message)}
        />
      )
    }
  } catch (error) {
    const code = getErrnoCode(error)
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'EPERM'
    ) {
      const message = `Couldn't find a directory at ${chalk.bold(requestedPath)}.`
      return (
        <CdError
          message={message}
          args={requested}
          onDone={() => onDone(message)}
        />
      )
    }
    throw error
  }

  let canonicalPath = requestedPath
  try {
    canonicalPath = await realpath(requestedPath)
  } catch {
    canonicalPath = requestedPath
  }

  if (canonicalPath === getCwd()) {
    const message = `Already in ${chalk.bold(canonicalPath)}.`
    return (
      <CdError
        message={message}
        args={requested}
        onDone={() => onDone(message)}
      />
    )
  }

  const check = checkCdPermission(
    { requestedPath, canonicalPath },
    context.getAppState().toolPermissionContext,
  )
  if (check.result !== 'allowed') {
    const message = formatCdDenial(canonicalPath, check)
    return (
      <CdError
        message={message}
        args={requested}
        onDone={() => onDone(message)}
      />
    )
  }

  const performMove = async () => {
    try {
      const notice = await performCd(canonicalPath)
      onDone(`Moved to ${chalk.bold(canonicalPath)}`, {
        display: 'system',
        metaMessages: [notice],
      })
    } catch (error) {
      logForDebugging(`/cd relocate failed: ${error}`, { level: 'error' })
      onDone(
        `Couldn't move to ${chalk.bold(canonicalPath)} — the directory may no longer exist, or the session couldn't be moved. Staying in ${chalk.bold(getCwd())}.`,
      )
    }
  }

  // Already trusted (this directory or an ancestor): skip the prompt.
  if (isPathTrusted(canonicalPath)) {
    await performMove()
    return null
  }
  return (
    <CdTrustPrompt
      directory={canonicalPath}
      onConfirm={() => {
        markPathTrusted(canonicalPath)
        void performMove()
      }}
      onCancel={() => {
        onDone(`Staying in ${chalk.bold(getCwd())}`)
      }}
    />
  )
}
