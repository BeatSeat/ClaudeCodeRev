import { join } from 'path'
import React, {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { StatusIcon } from 'src/components/design-system/StatusIcon.js'
import { KeybindingWarnings } from 'src/components/KeybindingWarnings.js'
import { McpParsingWarnings } from 'src/components/mcp/McpParsingWarnings.js'
import { getModelMaxOutputTokens } from 'src/utils/context.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { Pane } from '../components/design-system/Pane.js'
import { SandboxDoctorSection } from '../components/sandbox/SandboxDoctorSection.js'
import { ValidationErrorsList } from '../components/ValidationErrorsList.js'
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState } from '../state/AppState.js'
import { getPluginErrorMessage } from '../types/plugin.js'
import {
  getGcsDistTags,
  getNpmDistTags,
  type NpmDistTags,
} from '../utils/autoUpdater.js'
import {
  type ContextWarnings,
  checkContextWarnings,
} from '../utils/doctorContextWarnings.js'
import {
  type DiagnosticInfo,
  getDoctorDiagnostic,
} from '../utils/doctorDiagnostic.js'
import { validateBoundedIntEnvVar } from '../utils/envValidation.js'
import { pathExists } from '../utils/file.js'
import {
  cleanupStaleLocks,
  getAllLockInfo,
  isPidBasedLockingEnabled,
  type LockInfo,
} from '../utils/nativeInstaller/pidLock.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  BASH_MAX_OUTPUT_DEFAULT,
  BASH_MAX_OUTPUT_UPPER_LIMIT,
} from '../utils/shell/outputLimits.js'
import {
  TASK_MAX_OUTPUT_DEFAULT,
  TASK_MAX_OUTPUT_UPPER_LIMIT,
} from '../utils/task/outputFormatting.js'
import { getXDGStateHome } from '../utils/xdg.js'
import {
  getCachedKeybindingWarnings,
  getKeybindingsPath,
} from '../keybindings/loadUserBindings.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'

type Props = {
  onDone: LocalJSXCommandOnDone
}

/** Official uCY: prompt Claude to fix the issues /doctor just reported. */
function buildDoctorFixPrompt(
  diagnostic: DiagnosticInfo | null,
  agentInfo: AgentInfo | null,
  settingsErrorCount: number,
  pluginErrorCount: number,
  contextWarnings: ContextWarnings | null,
  envErrors: Array<{ name: string; message: string }>,
): string | null {
  const items: string[] = []
  for (const warning of diagnostic?.warnings ?? []) {
    items.push(`- ${warning.issue}\n  Suggested fix: ${warning.fix}`)
  }
  for (const warning of getCachedKeybindingWarnings()) {
    items.push(
      `- Keybinding (${getKeybindingsPath()}): ${warning.message}${
        warning.suggestion ? `\n  Suggested fix: ${warning.suggestion}` : ''
      }`,
    )
  }
  for (const file of agentInfo?.failedFiles ?? []) {
    items.push(
      `- Agent file failed to parse: ${file.path}\n  Error: ${file.error}`,
    )
  }
  if (settingsErrorCount > 0) {
    items.push(
      `- ${settingsErrorCount} invalid settings entries (see /doctor output)`,
    )
  }
  if (pluginErrorCount > 0) {
    items.push(`- ${pluginErrorCount} plugin error(s) (see /doctor output)`)
  }
  for (const warning of [
    contextWarnings?.claudeMdWarning,
    contextWarnings?.agentWarning,
    contextWarnings?.unreachableRulesWarning,
  ]) {
    if (warning) {
      items.push(`- ${warning.message}\n  ${warning.details.join('\n  ')}`)
    }
  }
  for (const env of envErrors) {
    items.push(`- Environment variable ${env.name}: ${env.message}`)
  }
  if (items.length === 0) {
    return null
  }
  return [
    'Help me fix the issues reported by /doctor below.',
    '',
    'For each issue: briefly explain what the fix will do, then ask me to confirm before running any shell command that deletes files, modifies global config, or changes my installation. Safe read-only checks are fine without asking. If a suggested fix looks wrong for my setup, say so instead of running it.',
    '',
    items.join('\n'),
  ].join('\n')
}

type AgentInfo = {
  activeAgents: Array<{
    agentType: string
    source: SettingSource | 'built-in' | 'plugin'
  }>
  userAgentsDir: string
  projectAgentsDir: string
  userDirExists: boolean
  projectDirExists: boolean
  failedFiles?: Array<{ path: string; error: string }>
}

type VersionLockInfo = {
  enabled: boolean
  locks: LockInfo[]
  locksDir: string
  staleLocksCleaned: number
}

function DistTagsDisplay({
  promise,
}: {
  promise: Promise<NpmDistTags>
}): React.ReactNode {
  const distTags = use(promise)
  if (!distTags.latest) {
    return <Text dimColor>└ Failed to fetch versions</Text>
  }
  return (
    <>
      {distTags.stable && <Text>└ Stable version: {distTags.stable}</Text>}
      <Text>└ Latest version: {distTags.latest}</Text>
    </>
  )
}

export function Doctor({ onDone }: Props): React.ReactNode {
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const mcpTools = useAppState(s => s.mcp.tools)
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const pluginsErrors = useAppState(s => s.plugins.errors)
  useExitOnCtrlCDWithKeybindings()

  const tools = useMemo(() => {
    return mcpTools || []
  }, [mcpTools])

  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo | null>(null)
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null)
  const [contextWarnings, setContextWarnings] =
    useState<ContextWarnings | null>(null)
  const [versionLockInfo, setVersionLockInfo] =
    useState<VersionLockInfo | null>(null)
  const validationErrors = useSettingsErrors()

  // Create promise once for dist-tags fetch (depends on diagnostic)
  const distTagsPromise = useMemo(
    () =>
      getDoctorDiagnostic().then(diag => {
        const fetchDistTags =
          diag.installationType === 'native' ? getGcsDistTags : getNpmDistTags
        return fetchDistTags().catch(() => ({ latest: null, stable: null }))
      }),
    [],
  )
  const autoUpdatesChannel =
    getInitialSettings()?.autoUpdatesChannel ?? 'latest'

  const errorsExcludingMcp = validationErrors.filter(
    error => error.mcpErrorMetadata === undefined,
  )

  const envValidationErrors = useMemo(() => {
    const envVars = [
      {
        name: 'BASH_MAX_OUTPUT_LENGTH',
        default: BASH_MAX_OUTPUT_DEFAULT,
        upperLimit: BASH_MAX_OUTPUT_UPPER_LIMIT,
      },
      {
        name: 'TASK_MAX_OUTPUT_LENGTH',
        default: TASK_MAX_OUTPUT_DEFAULT,
        upperLimit: TASK_MAX_OUTPUT_UPPER_LIMIT,
      },
      {
        name: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        // Check for values against the latest supported model
        ...getModelMaxOutputTokens('claude-opus-4-6'),
      },
    ]
    return envVars
      .map(v => {
        const value = process.env[v.name]
        const result = validateBoundedIntEnvVar(
          v.name,
          value,
          v.default,
          v.upperLimit,
        )
        return { name: v.name, ...result }
      })
      .filter(v => v.status !== 'valid')
  }, [])

  useEffect(() => {
    void getDoctorDiagnostic({ probeKeychain: true }).then(setDiagnostic)

    void (async () => {
      const userAgentsDir = join(getClaudeConfigHomeDir(), 'agents')
      const projectAgentsDir = join(getOriginalCwd(), '.claude', 'agents')

      const { activeAgents, allAgents, failedFiles } = agentDefinitions

      const [userDirExists, projectDirExists] = await Promise.all([
        pathExists(userAgentsDir),
        pathExists(projectAgentsDir),
      ])

      const agentInfoData = {
        activeAgents: activeAgents.map(a => ({
          agentType: a.agentType,
          source: a.source,
        })),
        userAgentsDir,
        projectAgentsDir,
        userDirExists,
        projectDirExists,
        failedFiles,
      }
      setAgentInfo(agentInfoData)

      const warnings = await checkContextWarnings(
        tools,
        {
          activeAgents,
          allAgents,
          failedFiles,
        },
        async () => toolPermissionContext,
      )
      setContextWarnings(warnings)

      // Fetch version lock info if PID-based locking is enabled
      if (isPidBasedLockingEnabled()) {
        const locksDir = join(getXDGStateHome(), 'claude', 'locks')
        const staleLocksCleaned = cleanupStaleLocks(locksDir)
        const locks = getAllLockInfo(locksDir)
        setVersionLockInfo({
          enabled: true,
          locks,
          locksDir,
          staleLocksCleaned,
        })
      } else {
        setVersionLockInfo({
          enabled: false,
          locks: [],
          locksDir: '',
          staleLocksCleaned: 0,
        })
      }
    })()
  }, [toolPermissionContext, tools, agentDefinitions])

  const handleDismiss = useCallback(() => {
    onDone('Claude Code diagnostics dismissed', { display: 'system' })
  }, [onDone])

  const fixPrompt = useMemo(
    () =>
      buildDoctorFixPrompt(
        diagnostic,
        agentInfo,
        errorsExcludingMcp.length,
        pluginsErrors.length,
        contextWarnings,
        envValidationErrors,
      ),
    [
      diagnostic,
      agentInfo,
      errorsExcludingMcp.length,
      pluginsErrors.length,
      contextWarnings,
      envValidationErrors,
    ],
  )

  const enterShortcut = useShortcutDisplay('confirm:yes', 'Confirmation', 'Enter')

  // Handle dismiss via keybindings (Enter, Escape, or Ctrl+C)
  useKeybindings(
    {
      'confirm:yes': handleDismiss,
      'confirm:no': handleDismiss,
    },
    { context: 'Confirmation' },
  )

  useKeybindings(
    {
      'doctor:fix': () => {
        if (fixPrompt) {
          onDone(fixPrompt, { display: 'user', shouldQuery: true })
        }
      },
    },
    { context: 'Doctor', isActive: fixPrompt !== null },
  )

  // Loading state
  if (!diagnostic) {
    return (
      <Pane>
        <Text dimColor>Checking installation status…</Text>
      </Pane>
    )
  }

  // Format the diagnostic output according to spec
  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>Diagnostics</Text>
        <Text>
          └ Currently running: {diagnostic.installationType} (
          {diagnostic.version})
        </Text>
        {diagnostic.packageManager && (
          <Text>└ Package manager: {diagnostic.packageManager}</Text>
        )}
        <Text>└ Path: {diagnostic.installationPath}</Text>
        {diagnostic.invokedBinary !== diagnostic.installationPath && (
          <Text>└ Invoked: {diagnostic.invokedBinary}</Text>
        )}
        <Text>└ Config install method: {diagnostic.configInstallMethod}</Text>
        <Text>
          └ Search: {diagnostic.ripgrepStatus.working ? 'OK' : 'Not working'} (
          {diagnostic.ripgrepStatus.mode === 'embedded'
            ? 'bundled'
            : diagnostic.ripgrepStatus.mode === 'builtin'
              ? 'vendor'
              : diagnostic.ripgrepStatus.systemPath || 'system'}
          )
        </Text>

        {/* Show recommendation if auto-updates are disabled */}
        {diagnostic.recommendation && (
          <>
            <Text></Text>
            <Text color="warning">
              Recommendation: {diagnostic.recommendation.split('\n')[0]}
            </Text>
            <Text dimColor>{diagnostic.recommendation.split('\n')[1]}</Text>
          </>
        )}

        {/* Show multiple installations warning */}
        {diagnostic.multipleInstallations.length > 1 && (
          <>
            <Text></Text>
            <Text>
              <StatusIcon status="warning" withSpace />
              Multiple installations found
            </Text>
            {diagnostic.multipleInstallations.map((install, i) => (
              <Text key={i}>
                └ {install.type} at {install.path}
              </Text>
            ))}
          </>
        )}

        {/* Show configuration warnings */}
        {diagnostic.warnings.length > 0 && (
          <>
            <Text></Text>
            {diagnostic.warnings.map((warning, i) => (
              <Box key={i} flexDirection="column">
                <Text>
                  <StatusIcon status="warning" withSpace />
                  {warning.issue}
                </Text>
                <Text>Fix: {warning.fix}</Text>
              </Box>
            ))}
          </>
        )}

        {/* Show invalid settings errors */}
        {errorsExcludingMcp.length > 0 && (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text bold>Invalid Settings</Text>
            <ValidationErrorsList errors={errorsExcludingMcp} />
          </Box>
        )}
      </Box>

      {/* Updates section */}
      <Box flexDirection="column">
        <Text bold>Updates</Text>
        <Text>
          └ Auto-updates:{' '}
          {diagnostic.packageManager
            ? 'Managed by package manager'
            : diagnostic.autoUpdates}
        </Text>
        {diagnostic.hasUpdatePermissions !== null && (
          <Text>
            └ Update permissions:{' '}
            {diagnostic.hasUpdatePermissions ? 'Yes' : 'No (requires sudo)'}
          </Text>
        )}
        <Text>└ Auto-update channel: {autoUpdatesChannel}</Text>
        <Suspense fallback={null}>
          <DistTagsDisplay promise={distTagsPromise} />
        </Suspense>
      </Box>

      <SandboxDoctorSection />

      <McpParsingWarnings />

      <KeybindingWarnings />

      {/* Environment Variables */}
      {envValidationErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Environment Variables</Text>
          {envValidationErrors.map((validation, i) => (
            <Text key={i}>
              └ {validation.name}:{' '}
              <Text
                color={validation.status === 'capped' ? 'warning' : 'error'}
              >
                {validation.message}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      {/* Version Locks (PID-based locking) */}
      {versionLockInfo?.enabled && (
        <Box flexDirection="column">
          <Text bold>Version Locks</Text>
          {versionLockInfo.staleLocksCleaned > 0 && (
            <Text dimColor>
              └ Cleaned {versionLockInfo.staleLocksCleaned} stale lock(s)
            </Text>
          )}
          {versionLockInfo.locks.length === 0 ? (
            <Text dimColor>└ No active version locks</Text>
          ) : (
            versionLockInfo.locks.map((lock, i) => (
              <Text key={i}>
                └ {lock.version}: PID {lock.pid}{' '}
                {lock.isProcessRunning ? (
                  <Text>(running)</Text>
                ) : (
                  <Text color="warning">(stale)</Text>
                )}
              </Text>
            ))
          )}
        </Box>
      )}

      {agentInfo?.failedFiles && agentInfo.failedFiles.length > 0 && (
        <Box flexDirection="column">
          <Text>
            <StatusIcon status="error" withSpace />
            <Text bold>Agent parse errors</Text>
          </Text>
          <Text color="error">
            └ Failed to parse {agentInfo.failedFiles.length} agent file(s):
          </Text>
          {agentInfo.failedFiles.map((file, i) => (
            <Text key={i} dimColor>
              {'  '}└ {file.path}: {file.error}
            </Text>
          ))}
        </Box>
      )}

      {/* Plugin Errors */}
      {pluginsErrors.length > 0 && (
        <Box flexDirection="column">
          <Text>
            <StatusIcon status="error" withSpace />
            <Text bold>Plugin errors</Text>
          </Text>
          <Text color="error">
            └ {pluginsErrors.length} plugin error(s) detected:
          </Text>
          {pluginsErrors.map((error, i) => (
            <Text key={i} dimColor>
              {'  '}└ {error.source || 'unknown'}
              {'plugin' in error && error.plugin ? ` [${error.plugin}]` : ''}:{' '}
              {getPluginErrorMessage(error)}
            </Text>
          ))}
        </Box>
      )}

      {/* Unreachable Permission Rules Warning */}
      {contextWarnings?.unreachableRulesWarning && (
        <Box flexDirection="column">
          <Text bold color="warning">
            Unreachable Permission Rules
          </Text>
          <Text>
            └{' '}
            <Text color="warning">
              <StatusIcon status="warning" withSpace />
              {contextWarnings.unreachableRulesWarning.message}
            </Text>
          </Text>
          {contextWarnings.unreachableRulesWarning.details.map((detail, i) => (
            <Text key={i} dimColor>
              {'  '}└ {detail}
            </Text>
          ))}
        </Box>
      )}

      {/* Context Usage Warnings */}
      {contextWarnings &&
        (contextWarnings.claudeMdWarning ||
          contextWarnings.agentWarning ||
          contextWarnings.mcpWarning) && (
          <Box flexDirection="column">
            <Text bold>Context Usage Warnings</Text>

            {contextWarnings.claudeMdWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    <StatusIcon status="warning" withSpace />
                    {contextWarnings.claudeMdWarning.message}
                  </Text>
                </Text>
                <Text>{'  '}└ Files:</Text>
                {contextWarnings.claudeMdWarning.details.map((detail, i) => (
                  <Text key={i} dimColor>
                    {'    '}└ {detail}
                  </Text>
                ))}
              </>
            )}

            {contextWarnings.agentWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    <StatusIcon status="warning" withSpace />
                    {contextWarnings.agentWarning.message}
                  </Text>
                </Text>
                <Text>{'  '}└ Top contributors:</Text>
                {contextWarnings.agentWarning.details.map((detail, i) => (
                  <Text key={i} dimColor>
                    {'    '}└ {detail}
                  </Text>
                ))}
              </>
            )}

            {contextWarnings.mcpWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    <StatusIcon status="warning" withSpace />
                    {contextWarnings.mcpWarning.message}
                  </Text>
                </Text>
                <Text>{'  '}└ MCP servers:</Text>
                {contextWarnings.mcpWarning.details.map((detail, i) => (
                  <Text key={i} dimColor>
                    {'    '}└ {detail}
                  </Text>
                ))}
              </>
            )}
          </Box>
        )}

      <Box marginTop={1}>
        <Text color="permission">
          Press {enterShortcut} to continue
          {fixPrompt ? (
            <>
              {' · '}
              <Text bold>f</Text> to fix with Claude
            </>
          ) : null}
        </Text>
      </Box>
    </Pane>
  )
}
