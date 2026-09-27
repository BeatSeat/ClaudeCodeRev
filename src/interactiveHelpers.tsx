import { feature } from 'bun:bundle'
import { appendFileSync } from 'fs'
import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { logError } from 'src/utils/log.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
} from 'src/utils/gracefulShutdown.js'
import {
  type ChannelEntry,
  getAllowedChannels,
  setAllowedChannels,
  setHasDevChannels,
  setSessionTrustAccepted,
  setStatsStore,
} from './bootstrap/state.js'
import type { Command } from './commands.js'
import { createStatsStore, type StatsStore } from './context/stats.js'
import { getSystemContext } from './context.js'
import { initializeTelemetryAfterTrust } from './entrypoints/init.js'
import { isSynchronizedOutputSupported } from './ink/terminal.js'
import type { RenderOptions, Root, TextProps } from './ink.js'
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js'
import { startDeferredPrefetches } from './main.js'
import {
  checkGate_CACHED_OR_BLOCKING,
  initializeGrowthBook,
  resetGrowthBook,
} from './services/analytics/growthbook.js'
import { isQualifiedForGrove } from './services/api/grove.js'
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js'
import { AppStateProvider } from './state/AppState.js'
import { onChangeAppState } from './state/onChangeAppState.js'
import { normalizeApiKeyForConfig } from './utils/authPortable.js'
import {
  getExternalClaudeMdIncludes,
  getMemoryFiles,
  shouldShowClaudeMdExternalIncludesWarning,
} from './utils/claudemd.js'
import {
  checkHasTrustDialogAccepted,
  getCustomApiKeyStatus,
  getGlobalConfig,
  saveGlobalConfig,
} from './utils/config.js'
import { resolveTeamOnboardingDiscoveryArm } from './commands/team-onboarding/discovery.js'
import {
  applyBedrockPinEnv,
  BEDROCK_TIER_LABELS,
  bedrockPinEnvPatch,
  bedrockUpgradeKey,
  checkBedrockDefaultAvailability,
  findBedrockUpgradeCandidates,
} from './utils/model/bedrockUpgrade.js'
import {
  applyVertexPinEnv,
  checkVertexDefaultAvailability,
  findVertexUpgradeCandidates,
  VERTEX_TIER_LABELS,
  vertexPinEnvPatch,
  vertexUpgradeKey,
} from './utils/model/vertexUpgrade.js'
import { logForDebugging } from './utils/debug.js'
import { execRelaunch } from './utils/relaunch.js'
import { updateSettingsForSource } from './utils/settings/settings.js'
import { sleep } from './utils/sleep.js'
import { updateDeepLinkTerminalPreference } from './utils/deepLink/terminalPreference.js'
import { isEnvTruthy, isRunningOnHomespace } from './utils/envUtils.js'
import { getAPIProvider } from './utils/model/providers.js'
import { type FpsMetrics, FpsTracker } from './utils/fpsTracker.js'
import { updateGithubRepoPathMapping } from './utils/githubRepoPathMapping.js'
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getBaseRenderOptions } from './utils/renderOptions.js'
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js'
import {
  hasAutoModeOptIn,
  hasSkipDangerousModePermissionPrompt,
} from './utils/settings/settings.js'

export function completeOnboarding(): void {
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
  }))
}
export function showDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>(resolve => {
    const done = (result: T): void => void resolve(result)
    root.render(renderer(done))
  })
}

/**
 * Render an error message through Ink, then unmount and exit.
 * Use this for fatal errors after the Ink root has been created —
 * console.error is swallowed by Ink's patchConsole, so we render
 * through the React tree instead.
 */
export async function exitWithError(
  root: Root,
  message: string,
  beforeExit?: () => Promise<void>,
): Promise<never> {
  return exitWithMessage(root, message, { color: 'error', beforeExit })
}

/**
 * Render a message through Ink, then unmount and exit.
 * Use this for messages after the Ink root has been created —
 * console output is swallowed by Ink's patchConsole, so we render
 * through the React tree instead.
 */
export async function exitWithMessage(
  root: Root,
  message: string,
  options?: {
    color?: TextProps['color']
    exitCode?: number
    beforeExit?: () => Promise<void>
  },
): Promise<never> {
  const { Text } = await import('./ink.js')
  const color = options?.color
  const exitCode = options?.exitCode ?? 1
  root.render(
    color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>,
  )
  root.unmount()
  await options?.beforeExit?.()
  // eslint-disable-next-line custom-rules/no-process-exit -- exit after Ink unmount
  process.exit(exitCode)
}

/**
 * Show a setup dialog wrapped in AppStateProvider + KeybindingSetup.
 * Reduces boilerplate in showSetupScreens() where every dialog needs these wrappers.
 */
export function showSetupDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
  options?: { onChangeAppState?: typeof onChangeAppState },
): Promise<T> {
  return showDialog<T>(root, done => (
    <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>{renderer(done)}</KeybindingSetup>
    </AppStateProvider>
  ))
}

/**
 * Render the main UI into the root and wait for it to exit.
 * Handles the common epilogue: start deferred prefetches, wait for exit, graceful shutdown.
 */
export async function renderAndRun(
  root: Root,
  element: React.ReactNode,
): Promise<void> {
  root.render(element)
  startDeferredPrefetches()
  await root.waitUntilExit()
  await gracefulShutdown(0)
}

export async function showSetupScreens(
  root: Root,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  claudeInChrome?: boolean,
  devChannels?: ChannelEntry[],
): Promise<boolean> {
  if (
    "production" === 'test' ||
    isEnvTruthy(false) ||
    process.env.IS_DEMO // Skip onboarding in demo mode
  ) {
    return false
  }

  const config = getGlobalConfig()
  let onboardingShown = false
  if (
    !config.theme ||
    !config.hasCompletedOnboarding // always show onboarding at least once
  ) {
    onboardingShown = true
    const { Onboarding } = await import('./components/Onboarding.js')
    await showSetupDialog(
      root,
      done => (
        <Onboarding
          onDone={() => {
            completeOnboarding()
            void done()
          }}
        />
      ),
      { onChangeAppState },
    )
  }

  // Always show the trust dialog in interactive sessions, regardless of permission mode.
  // The trust dialog is the workspace trust boundary — it warns about untrusted repos
  // and checks CLAUDE.md external includes. bypassPermissions mode
  // only affects tool execution permissions, not workspace trust.
  // Note: non-interactive sessions (CI/CD with -p) never reach showSetupScreens at all.
  // Skip permission checks in claubbit
  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    // Fast-path: skip TrustDialog import+render when CWD is already trusted.
    // If it returns true, the TrustDialog would auto-resolve regardless of
    // security features, so we can skip the dynamic import and render cycle.
    if (!checkHasTrustDialogAccepted()) {
      const { TrustDialog } = await import(
        './components/TrustDialog/TrustDialog.js'
      )
      await showSetupDialog(root, done => (
        <TrustDialog commands={commands} onDone={done} />
      ))
    }

    // Signal that trust has been verified for this session.
    // GrowthBook checks this to decide whether to include auth headers.
    setSessionTrustAccepted(true)

    // Reset and reinitialize GrowthBook after trust is established.
    // Defense for login/logout: clears any prior client so the next init
    // picks up fresh auth headers.
    resetGrowthBook()
    void initializeGrowthBook()

    // Now that trust is established, prefetch system context if it wasn't already
    void getSystemContext()

    // If settings are valid, check for any mcp.json servers that need approval
    const { errors: allErrors } = getSettingsWithAllErrors()
    if (allErrors.length === 0) {
      await handleMcpjsonServerApprovals(root)
    }

    // Check for claude.md includes that need approval
    if (await shouldShowClaudeMdExternalIncludesWarning()) {
      const externalIncludes = getExternalClaudeMdIncludes(
        await getMemoryFiles(true),
      )
      const { ClaudeMdExternalIncludesDialog } = await import(
        './components/ClaudeMdExternalIncludesDialog.js'
      )
      await showSetupDialog(root, done => (
        <ClaudeMdExternalIncludesDialog
          onDone={done}
          isStandaloneDialog
          externalIncludes={externalIncludes}
        />
      ))
    }
  }

  // Track current repo path for teleport directory switching (fire-and-forget)
  // This must happen AFTER trust to prevent untrusted directories from poisoning the mapping
  void updateGithubRepoPathMapping()
  if (feature('LODESTONE')) {
    updateDeepLinkTerminalPreference()
  }

  // Apply full environment variables after trust dialog is accepted OR in bypass mode
  // In bypass mode (CI/CD, automation), we trust the environment so apply all variables
  // In normal mode, this happens after the trust dialog is accepted
  // This includes potentially dangerous environment variables from untrusted sources
  applyConfigEnvironmentVariables()

  // Initialize telemetry after env vars are applied so OTEL endpoint env vars and
  // otelHeadersHelper (which requires trust to execute) are available.
  // Defer to next tick so the OTel dynamic import resolves after first render
  // instead of during the pre-render microtask queue.
  setImmediate(() => initializeTelemetryAfterTrust())

  if (await isQualifiedForGrove()) {
    const { GroveDialog } = await import('src/components/grove/Grove.js')
    const decision = await showSetupDialog<string>(root, done => (
      <GroveDialog
        showIfAlreadyViewed={false}
        location={onboardingShown ? 'onboarding' : 'policy_update_modal'}
        onDone={done}
      />
    ))
    if (decision === 'escape') {
      logEvent('tengu_grove_policy_exited', {})
      gracefulShutdownSync(0)
      return false
    }
  }

  if (onboardingShown && resolveTeamOnboardingDiscoveryArm() === 'step') {
    const { TeamOnboardingDiscoveryStep } = await import(
      './components/TeamOnboardingDiscoveryStep.js'
    )
    await showSetupDialog(root, done => (
      <TeamOnboardingDiscoveryStep onDone={done} />
    ))
  }

  // Check for custom API key
  // On homespace, ANTHROPIC_API_KEY is preserved in process.env for child
  // processes but ignored by Claude Code itself (see auth.ts).
  if (
    process.env.ANTHROPIC_API_KEY &&
    !isRunningOnHomespace() &&
    getAPIProvider() === 'firstParty'
  ) {
    const customApiKeyTruncated = normalizeApiKeyForConfig(
      process.env.ANTHROPIC_API_KEY,
    )
    const keyStatus = getCustomApiKeyStatus(customApiKeyTruncated)
    if (keyStatus === 'new') {
      const { ApproveApiKey } = await import('./components/ApproveApiKey.js')
      await showSetupDialog<boolean>(
        root,
        done => (
          <ApproveApiKey
            customApiKeyTruncated={customApiKeyTruncated}
            onDone={done}
          />
        ),
        { onChangeAppState },
      )
    }
  }

  try {
    await runBedrockUpgradeDialogs(root)
  } catch (err) {
    logError(err)
  }
  try {
    await runBedrockDefaultFallbackToast(root)
  } catch (err) {
    logError(err)
  }
  try {
    await runVertexUpgradeDialogs(root)
  } catch (err) {
    logError(err)
  }
  try {
    await runVertexDefaultFallbackToast(root)
  } catch (err) {
    logError(err)
  }

  if (
    (permissionMode === 'bypassPermissions' ||
      allowDangerouslySkipPermissions) &&
    !hasSkipDangerousModePermissionPrompt()
  ) {
    const { BypassPermissionsModeDialog } = await import(
      './components/BypassPermissionsModeDialog.js'
    )
    await showSetupDialog(root, done => (
      <BypassPermissionsModeDialog onAccept={done} />
    ))
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Only show the opt-in dialog if auto mode actually resolved — if the
    // gate denied it (org not allowlisted, settings disabled), showing
    // consent for an unavailable feature is pointless. The
    // verifyAutoModeGateAccess notification will explain why instead.
    if (permissionMode === 'auto' && !hasAutoModeOptIn()) {
      const { AutoModeOptInDialog } = await import(
        './components/AutoModeOptInDialog.js'
      )
      await showSetupDialog(root, done => (
        <AutoModeOptInDialog
          onAccept={done}
          onDecline={() => gracefulShutdownSync(1)}
          declineExits
        />
      ))
    }
  }

  // --dangerously-load-development-channels confirmation. On accept, append
  // dev channels to any --channels list already set in main.tsx. Org policy
  // is NOT bypassed — gateChannelServer() still runs; this flag only exists
  // to sidestep the --channels approved-server allowlist.
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    // gateChannelServer and ChannelsNotice read tengu_harbor after this
    // function returns. A cold disk cache (fresh install, or first run after
    // the flag was added server-side) defaults to false and silently drops
    // channel notifications for the whole session — gh#37026.
    // checkGate_CACHED_OR_BLOCKING returns immediately if disk already says
    // true; only blocks on a cold/stale-false cache (awaits the same memoized
    // initializeGrowthBook promise fired earlier). Also warms the
    // isChannelsEnabled() check in the dev-channels dialog below.
    if (getAllowedChannels().length > 0 || (devChannels?.length ?? 0) > 0) {
      await checkGate_CACHED_OR_BLOCKING('tengu_harbor')
    }

    if (devChannels && devChannels.length > 0) {
      const [{ isChannelsEnabled }, { getClaudeAIOAuthTokens }] =
        await Promise.all([
          import('./services/mcp/channelAllowlist.js'),
          import('./utils/auth.js'),
        ])
      // Skip the dialog when channels are blocked (tengu_harbor off or no
      // OAuth) — accepting then immediately seeing "not available" in
      // ChannelsNotice is worse than no dialog. Append entries anyway so
      // ChannelsNotice renders the blocked branch with the dev entries
      // named. dev:true here is for the flag label in ChannelsNotice
      // (hasNonDev check); the allowlist bypass it also grants is moot
      // since the gate blocks upstream.
      if (!isChannelsEnabled() || !getClaudeAIOAuthTokens()?.accessToken) {
        setAllowedChannels([
          ...getAllowedChannels(),
          ...devChannels.map(c => ({ ...c, dev: true })),
        ])
        setHasDevChannels(true)
      } else {
        const { DevChannelsDialog } = await import(
          './components/DevChannelsDialog.js'
        )
        await showSetupDialog(root, done => (
          <DevChannelsDialog
            channels={devChannels}
            onAccept={() => {
              // Mark dev entries per-entry so the allowlist bypass doesn't leak
              // to --channels entries when both flags are passed.
              setAllowedChannels([
                ...getAllowedChannels(),
                ...devChannels.map(c => ({ ...c, dev: true })),
              ])
              setHasDevChannels(true)
              void done()
            }}
          />
        ))
      }
    }
  }

  // Show Chrome onboarding for first-time Claude in Chrome users
  if (
    claudeInChrome &&
    !getGlobalConfig().hasCompletedClaudeInChromeOnboarding
  ) {
    const { ClaudeInChromeOnboarding } = await import(
      './components/ClaudeInChromeOnboarding.js'
    )
    await showSetupDialog(root, done => (
      <ClaudeInChromeOnboarding onDone={done} />
    ))
  }

  return onboardingShown
}

/** Official 2.1.98 Ta8 / 2.1.108 Jt8 — empty result if the 3P probe overruns. */
const THIRD_PARTY_PROBE_DEADLINE_MS = 20_000

async function with3pProbeDeadline<T>(
  label: string,
  work: Promise<T[]>,
): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T[]>(resolve => {
        timer = setTimeout(
          (done: (value: T[]) => void, name: string) => {
            logForDebugging(
              `[3p-probe] ${name} hit ${THIRD_PARTY_PROBE_DEADLINE_MS}ms deadline; proceeding without it`,
            )
            done([])
          },
          THIRD_PARTY_PROBE_DEADLINE_MS,
          resolve,
          label,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Official 2.1.98 J9A. */
async function runBedrockUpgradeDialogs(root: Root): Promise<void> {
  const candidates = await with3pProbeDeadline(
    'bedrock-upgrade',
    findBedrockUpgradeCandidates(),
  )
  if (candidates.length === 0) return
  const declined = getGlobalConfig().bedrockDeclinedUpgrades ?? {}
  const pending = candidates.filter(
    row => declined[row.tier] !== bedrockUpgradeKey(row),
  )
  if (pending.length === 0) return

  const { ThirdPartyModelUpgradeDialog } = await import(
    './components/ThirdPartyModelUpgradeDialog.js'
  )
  let accepted = false
  for (const row of pending) {
    const yes = await showSetupDialog<boolean>(root, done => (
      <ThirdPartyModelUpgradeDialog
        tierLabel={BEDROCK_TIER_LABELS[row.tier]}
        fromName={row.fromMarketingName}
        toName={row.toMarketingName}
        toProviderId={row.toBedrockId}
        onDone={done}
      />
    ))
    if (yes) {
      const env = bedrockPinEnvPatch(row.tier, row.envVar, row.toBedrockId)
      const { error } = updateSettingsForSource('userSettings', { env })
      if (error) {
        logEvent('tengu_bedrock_upgrade_save_failed', { tier: row.tier })
        const { Text } = await import('./ink.js')
        await showDialog(root, done => {
          setTimeout(done, 2000)
          return (
            <Text color="error">
              Failed to save {BEDROCK_TIER_LABELS[row.tier]} upgrade to
              settings.
            </Text>
          )
        })
      } else {
        applyBedrockPinEnv(row.tier, row.envVar, row.toBedrockId)
        accepted = true
        logEvent('tengu_bedrock_upgrade_accepted', {
          tier: row.tier,
          from_key: row.fromKey,
          to_key: row.toKey,
        })
      }
    } else {
      saveGlobalConfig(current => ({
        ...current,
        bedrockDeclinedUpgrades: {
          ...current.bedrockDeclinedUpgrades,
          [row.tier]: bedrockUpgradeKey(row),
        },
      }))
      logEvent('tengu_bedrock_upgrade_declined', {
        tier: row.tier,
        from_key: row.fromKey,
        to_key: row.toKey,
      })
    }
  }
  if (accepted) {
    logEvent('tengu_bedrock_upgrade_relaunch', {})
    const { Text } = await import('./ink.js')
    root.render(
      <Text dimColor>Restarting Claude Code to apply the new model…</Text>,
    )
    await sleep(250)
    root.unmount()
    await execRelaunch()
  }
}

/** Official 2.1.98 X9A — session-only fallback when the default model is dark. */
async function runBedrockDefaultFallbackToast(root: Root): Promise<void> {
  const fallbacks = await with3pProbeDeadline(
    'bedrock-fallback',
    checkBedrockDefaultAvailability(),
  )
  if (fallbacks.length === 0) return
  for (const row of fallbacks) {
    applyBedrockPinEnv(row.tier, row.envVar, row.fallbackBedrockId)
    logEvent('tengu_bedrock_default_fallback', {
      tier: row.tier,
      default_key: row.defaultKey,
      fallback_key: row.fallbackKey,
    })
  }
  const { Box, Text } = await import('./ink.js')
  const lines = fallbacks.map(
    row =>
      `${BEDROCK_TIER_LABELS[row.tier]}: ${row.defaultName} not available — using ${row.fallbackName} for this session`,
  )
  await showDialog(root, done => {
    setTimeout(done, 1500)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text key={line} color="warning">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}

/** Official 2.1.98 M9A. */
async function runVertexUpgradeDialogs(root: Root): Promise<void> {
  const candidates = await with3pProbeDeadline(
    'vertex-upgrade',
    findVertexUpgradeCandidates(),
  )
  if (candidates.length === 0) return
  const declined = getGlobalConfig().vertexDeclinedUpgrades ?? {}
  const pending = candidates.filter(
    row => declined[row.tier] !== vertexUpgradeKey(row),
  )
  if (pending.length === 0) return

  const { ThirdPartyModelUpgradeDialog } = await import(
    './components/ThirdPartyModelUpgradeDialog.js'
  )
  let accepted = false
  for (const row of pending) {
    const yes = await showSetupDialog<boolean>(root, done => (
      <ThirdPartyModelUpgradeDialog
        tierLabel={VERTEX_TIER_LABELS[row.tier]}
        fromName={row.fromMarketingName}
        toName={row.toMarketingName}
        toProviderId={row.toVertexId}
        onDone={done}
      />
    ))
    if (yes) {
      const env = vertexPinEnvPatch(row.tier, row.envVar, row.toVertexId)
      const { error } = updateSettingsForSource('userSettings', { env })
      if (error) {
        logEvent('tengu_vertex_upgrade_save_failed', { tier: row.tier })
        const { Text } = await import('./ink.js')
        await showDialog(root, done => {
          setTimeout(done, 2000)
          return (
            <Text color="error">
              Failed to save {VERTEX_TIER_LABELS[row.tier]} upgrade to
              settings.
            </Text>
          )
        })
      } else {
        applyVertexPinEnv(row.tier, row.envVar, row.toVertexId)
        accepted = true
        logEvent('tengu_vertex_upgrade_accepted', {
          tier: row.tier,
          from_key: row.fromKey,
          to_key: row.toKey,
        })
      }
    } else {
      saveGlobalConfig(current => ({
        ...current,
        vertexDeclinedUpgrades: {
          ...current.vertexDeclinedUpgrades,
          [row.tier]: vertexUpgradeKey(row),
        },
      }))
      logEvent('tengu_vertex_upgrade_declined', {
        tier: row.tier,
        from_key: row.fromKey,
        to_key: row.toKey,
      })
    }
  }
  if (accepted) {
    logEvent('tengu_vertex_upgrade_relaunch', {})
    const { Text } = await import('./ink.js')
    root.render(
      <Text dimColor>Restarting Claude Code to apply the new model…</Text>,
    )
    await sleep(250)
    root.unmount()
    await execRelaunch()
  }
}

/** Official 2.1.98 P9A — session-only fallback when the default Vertex model is dark. */
async function runVertexDefaultFallbackToast(root: Root): Promise<void> {
  const fallbacks = await with3pProbeDeadline(
    'vertex-fallback',
    checkVertexDefaultAvailability(),
  )
  if (fallbacks.length === 0) return
  for (const row of fallbacks) {
    applyVertexPinEnv(row.tier, row.envVar, row.fallbackVertexId)
    logEvent('tengu_vertex_default_fallback', {
      tier: row.tier,
      default_key: row.defaultKey,
      fallback_key: row.fallbackKey,
    })
  }
  const { Box, Text } = await import('./ink.js')
  const lines = fallbacks.map(
    row =>
      `${VERTEX_TIER_LABELS[row.tier]}: ${row.defaultName} not available — using ${row.fallbackName} for this session`,
  )
  await showDialog(root, done => {
    setTimeout(done, 1500)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text key={line} color="warning">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}

export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
} {
  let lastFlickerTime = 0
  const baseOptions = getBaseRenderOptions(exitOnCtrlC)

  // Log analytics event when stdin override is active
  if (baseOptions.stdin) {
    logEvent('tengu_stdin_interactive', {})
  }

  const fpsTracker = new FpsTracker()
  const stats = createStatsStore()
  setStatsStore(stats)

  // Bench mode: when set, append per-frame phase timings as JSONL for
  // offline analysis by bench/repl-scroll.ts. Captures the full TUI
  // render pipeline (yoga → screen buffer → diff → optimize → stdout)
  // so perf work on any phase can be validated against real user flows.
  const frameTimingLogPath = process.env.CLAUDE_CODE_FRAME_TIMING_LOG
  return {
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      onFrame: event => {
        fpsTracker.record(event.durationMs)
        stats.observe('frame_duration_ms', event.durationMs)
        if (frameTimingLogPath && event.phases) {
          // Bench-only env-var-gated path: sync write so no frames dropped
          // on abrupt exit. ~100 bytes at ≤60fps is negligible. rss/cpu are
          // single syscalls; cpu is cumulative — bench side computes delta.
          const line =
            // eslint-disable-next-line custom-rules/no-direct-json-operations -- tiny object, hot bench path
            JSON.stringify({
              total: event.durationMs,
              ...event.phases,
              rss: process.memoryUsage.rss(),
              cpu: process.cpuUsage(),
            }) + '\n'
          // eslint-disable-next-line custom-rules/no-sync-fs -- bench-only, sync so no frames dropped on exit
          appendFileSync(frameTimingLogPath, line)
        }
        // Skip flicker reporting for terminals with synchronized output —
        // DEC 2026 buffers between BSU/ESU so clear+redraw is atomic.
        if (isSynchronizedOutputSupported()) {
          return
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue
          }
          const now = Date.now()
          if (now - lastFlickerTime < 1000) {
            logEvent('tengu_flicker', {
              desiredHeight: flicker.desiredHeight,
              actualHeight: flicker.availableHeight,
              reason: flicker.reason,
            } as unknown as Record<string, boolean | number | undefined>)
          }
          lastFlickerTime = now
        }
      },
    },
  }
}
