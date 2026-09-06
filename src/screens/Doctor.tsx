import { join } from 'path'
import React, {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { DoctorSectionTitle } from 'src/components/design-system/DoctorSectionTitle.js'
import { List } from 'src/components/design-system/List.js'
import { StatusIcon } from 'src/components/design-system/StatusIcon.js'
import { KeybindingWarnings } from 'src/components/KeybindingWarnings.js'
import { McpParsingWarnings } from 'src/components/mcp/McpParsingWarnings.js'
import { getModelMaxOutputTokens } from 'src/utils/context.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { Byline } from '../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../components/design-system/KeyboardShortcutHint.js'
import { Pane } from '../components/design-system/Pane.js'
import { SandboxDoctorSection } from '../components/sandbox/SandboxDoctorSection.js'
import { SkillsDoctorSection } from '../components/skills/SkillsDoctorSection.js'
import { ValidationErrorsList } from '../components/ValidationErrorsList.js'
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState } from '../state/AppState.js'
import { getPluginErrorMessage } from '../types/plugin.js'
import { plural } from '../utils/stringUtils.js'
import { getAutoupdateHeldErrors } from '../utils/plugins/pluginAutoupdate.js'
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
import { formatLastUpdateResult } from '../utils/lastUpdateResult.js'
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
  const mcpClients = useAppState(s => s.mcp.clients)
  const pluginsErrorsFromState = useAppState(s => s.plugins.errors)
  // Official 2.1.178 `DMq`: drop `ineffective-disable` plugin notes.
  const pluginWarnings = useAppState(s => {
    const extra = s.plugins as { warnings?: Array<{ type: string }> }
    return (extra.warnings ?? []).filter(w => w.type !== 'ineffective-disable')
  })
  // Official 2.1.118: autoupdate-held errors may land after startup load.
  const pluginsErrors = [
    ...pluginsErrorsFromState,
    ...getAutoupdateHeldErrors().filter(
      held =>
        !pluginsErrorsFromState.some(
          e =>
            e.type === held.type && e.source === held.source,
        ),
    ),
  ]
  const mcpNotConnected = useMemo(
    () =>
      mcpClients.filter(
        c => c.type === 'failed' || c.type === 'needs-auth',
      ),
    [mcpClients],
  )

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

  // Official 2.1.178 `DMq`/`bY(z)` — double-press shows "again to close".
  const exitState = useExitOnCtrlCDWithKeybindings(handleDismiss)

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
        <Text>
          Last update attempt:{' '}
          {formatLastUpdateResult(diagnostic.lastUpdateResult)}
        </Text>
        <Suspense fallback={null}>
          <DistTagsDisplay promise={distTagsPromise} />
        </Suspense>
      </Box>

      <SandboxDoctorSection />
      <SkillsDoctorSection />

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

      {/* Official 2.1.178 `o49` — TZ + XK + C8 */}
      {(pluginsErrors.length > 0 || pluginWarnings.length > 0) && (
        <>
          {pluginsErrors.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <DoctorSectionTitle title="Plugin errors" status="error" />
              <List variant="tree">
                <List.Node color="error">
                  {`${pluginsErrors.length} plugin ${plural(pluginsErrors.length, 'error')} detected:`}
                </List.Node>
                {pluginsErrors.map((error, i) => (
                  <List.Node key={i} dimColor>
                    {error.source || 'unknown'}
                    {'plugin' in error && error.plugin
                      ? ` [${error.plugin}]`
                      : ''}
                    {': '}
                    {getPluginErrorMessage(error)}
                  </List.Node>
                ))}
              </List>
            </Box>
          )}
          {pluginWarnings.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <DoctorSectionTitle title="Plugin notes" status="warning" />
              <List variant="tree">
                <List.Node color="warning">
                  {`${pluginWarnings.length} plugin ${plural(pluginWarnings.length, 'note')}:`}
                </List.Node>
                {pluginWarnings.map((warning, i) => (
                  <List.Node key={i} dimColor>
                    {'source' in warning && typeof warning.source === 'string'
                      ? warning.source
                      : warning.type}
                  </List.Node>
                ))}
              </List>
            </Box>
          )}
        </>
      )}

      {/* Official 2.1.178 `n49` */}
      {mcpNotConnected.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <DoctorSectionTitle
            title="MCP servers"
            status={mcpNotConnected.some(c => c.type === 'failed') ? 'error' : 'warning'}
          />
          <List variant="tree">
            <List.Node
              color={
                mcpNotConnected.some(c => c.type === 'failed')
                  ? 'error'
                  : 'warning'
              }
            >
              {`${mcpNotConnected.length} MCP ${plural(mcpNotConnected.length, 'server')} not connected — run /mcp to authenticate, retry, or see details:`}
            </List.Node>
            {mcpNotConnected.map((client, i) => (
              <List.Node key={i} dimColor>
                {client.name}
                {': '}
                {client.type === 'needs-auth'
                  ? 'needs authentication'
                  : 'errorCode' in client &&
                      (client as { errorCode?: string }).errorCode ===
                        'INVALID_CONFIG'
                    ? 'config issue'
                    : 'failed'}
                {client.type === 'failed' && client.error
                  ? ` — ${client.error}`
                  : ''}
              </List.Node>
            ))}
          </List>
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

      {/* Official 2.1.178 `Q49` — context warnings as XK.Group */}
      {contextWarnings &&
        (contextWarnings.claudeMdWarning ||
          contextWarnings.agentWarning ||
          contextWarnings.mcpWarning) && (
          <Box flexDirection="column" marginTop={1}>
            <DoctorSectionTitle
              title="Context usage warnings"
              status="warning"
            />
            <List variant="tree">
              {contextWarnings.claudeMdWarning && (
                <List.Group>
                  <List.Node color="warning">
                    {contextWarnings.claudeMdWarning.message}
                  </List.Node>
                  {contextWarnings.claudeMdWarning.details.map((detail, i) => (
                    <List.Node key={i} dimColor>
                      {detail}
                    </List.Node>
                  ))}
                </List.Group>
              )}
              {contextWarnings.agentWarning && (
                <List.Group>
                  <List.Node color="warning">
                    {contextWarnings.agentWarning.message}
                  </List.Node>
                  {contextWarnings.agentWarning.details.map((detail, i) => (
                    <List.Node key={i} dimColor>
                      {detail}
                    </List.Node>
                  ))}
                </List.Group>
              )}
              {contextWarnings.mcpWarning && (
                <List.Group>
                  <List.Node color="warning">
                    {contextWarnings.mcpWarning.message}
                  </List.Node>
                  {contextWarnings.mcpWarning.details.map((detail, i) => (
                    <List.Node key={i} dimColor>
                      {detail}
                    </List.Node>
                  ))}
                </List.Group>
              )}
            </List>
          </Box>
        )}

      <Box marginTop={1}>
        <Text dimColor italic>
          {exitState.pending ? (
            <>
              Press {exitState.keyName} again to close
            </>
          ) : (
            <Byline>
              <KeyboardShortcutHint chord="enter" action="close" />
              {fixPrompt ? (
                <KeyboardShortcutHint shortcut="f" action="fix with Claude" />
              ) : null}
            </Byline>
          )}
        </Text>
      </Box>
    </Pane>
  )
}
