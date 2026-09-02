import { homedir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { useState } from 'react'
import { useInterval } from 'usehooks-ts'
import { Box, Text } from '../ink.js'
import { logEvent } from '../services/analytics/index.js'
import {
  type AutoUpdaterResult,
  getLatestVersionFromGcs,
  getMaxVersion,
  isAutoUpdateCheckThrottled,
  shouldSkipVersion,
} from '../utils/autoUpdater.js'
import { isAutoUpdaterDisabled } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import {
  getHomebrewCaskName,
  getPackageManager,
  type PackageManager,
} from '../utils/nativeInstaller/packageManagers.js'
import { gt, gte } from '../utils/semver.js'
import { getInitialSettings } from '../utils/settings/settings.js'

type Props = {
  isUpdating: boolean
  onChangeIsUpdating: (isUpdating: boolean) => void
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult | null) => void
  autoUpdaterResult: AutoUpdaterResult | null
  showSuccessMessage: boolean
  verbose: boolean
}

/** Official 2.1.129 `z04`: check interval, and the retry cooldown after a failed install. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/** Official 2.1.129 `A04`: module-scope so a failed install backs off across re-mounts. */
let lastInstallFailedAt = 0

/**
 * Official 2.1.129 `VV5`: the argv used to perform the upgrade in the
 * background. Package managers without a single unambiguous CLI (apk, mise,
 * pacman, deb, rpm) return null and only get the printed hint below.
 */
function getUpgradeArgv(
  packageManager: PackageManager,
  caskName: string | null,
): string[] | null {
  switch (packageManager) {
    case 'homebrew':
      return ['brew', 'upgrade', '--cask', caskName ?? 'claude-code']
    case 'winget': {
      // winget.exe isn't always on PATH for the WindowsApps shim.
      const localAppData = process.env.LOCALAPPDATA
      return [
        localAppData
          ? join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')
          : 'winget',
        'upgrade',
        '--id',
        'Anthropic.ClaudeCode',
        '--exact',
        '--silent',
        '--disable-interactivity',
      ]
    }
    default:
      return null
  }
}

/**
 * Official 2.1.129 `vV5`. pacman, deb, and rpm don't get specific commands
 * because they each have multiple frontends (pacman: yay/paru/makepkg, deb:
 * apt/apt-get/aptitude/nala, rpm: dnf/yum/zypper).
 */
function getUpgradeHint(
  packageManager: PackageManager,
  caskName: string | null,
): string {
  switch (packageManager) {
    case 'homebrew':
      return `brew upgrade ${caskName ?? 'claude-code'}`
    case 'winget':
      return 'winget upgrade Anthropic.ClaudeCode'
    case 'mise':
      return 'mise upgrade claude'
    case 'apk':
      return 'apk upgrade claude-code'
    default:
      return 'your package manager update command'
  }
}

export function PackageManagerAutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose,
}: Props): React.ReactNode {
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [packageManager, setPackageManager] =
    useState<PackageManager>('unknown')
  const [caskName, setCaskName] = useState<string | null>(null)

  // Refs so the interval callback below always sees current values without
  // being re-created (and re-scheduled) on every render.
  const isUpdatingRef = React.useRef(isUpdating)
  React.useEffect(() => {
    isUpdatingRef.current = isUpdating
  })
  const resultRef = React.useRef(autoUpdaterResult)
  React.useEffect(() => {
    resultRef.current = autoUpdaterResult
  })

  React.useEffect(() => {
    void getPackageManager().then(pm => {
      setPackageManager(pm)
      if (pm === 'homebrew') setCaskName(getHomebrewCaskName())
    })
  }, [])

  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) return
    if (resultRef.current?.status === 'success') return
    if (isAutoUpdaterDisabled()) return
    if (isAutoUpdateCheckThrottled()) return
    if (resultRef.current?.status === 'install_failed') {
      if (Date.now() - lastInstallFailedAt < CHECK_INTERVAL_MS) return
      resultRef.current = null
      onAutoUpdaterResult(null)
    }

    const [channel, pm] = await Promise.all([
      Promise.resolve(getInitialSettings()?.autoUpdatesChannel ?? 'latest'),
      getPackageManager(),
    ])

    let resolvedChannel = channel
    let cask: string | null = null
    if (pm === 'homebrew') {
      cask = getHomebrewCaskName()
      resolvedChannel = cask === 'claude-code@latest' ? 'latest' : 'stable'
    }

    let latest = await getLatestVersionFromGcs(resolvedChannel)

    // Check if max version is set (server-side kill switch for auto-updates)
    const maxVersion = await getMaxVersion()
    let cappedByMaxVersion = false

    if (maxVersion && latest && gt(latest, maxVersion)) {
      logForDebugging(
        `PackageManagerAutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latest} to ${maxVersion}`,
      )
      if (gte(MACRO.VERSION, maxVersion)) {
        logForDebugging(
          `PackageManagerAutoUpdater: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`,
        )
        setUpdateVersion(null)
        return
      }
      latest = maxVersion
      cappedByMaxVersion = true
    }

    const hasUpdate =
      latest && !gte(MACRO.VERSION, latest) && !shouldSkipVersion(latest)

    setUpdateVersion(hasUpdate ? latest : null)
    if (!hasUpdate || !latest) return

    logForDebugging(
      `PackageManagerAutoUpdater: Update available ${MACRO.VERSION} -> ${latest}`,
    )

    // Official 2.1.129: opt-in. Without the env var the hint below is all the
    // user gets, as in 2.1.128. A maxVersion-capped target is never installed
    // in the background — the cap exists to hold users back.
    const autoUpdateEnabled = isEnvTruthy(
      process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE,
    )
    const argv = getUpgradeArgv(pm, cask)
    if (!autoUpdateEnabled || !argv || cappedByMaxVersion) return
    if (isUpdatingRef.current) return

    onChangeIsUpdating(true)
    const startedAt = Date.now()
    const pmMetadata = {
      pm_homebrew: pm === 'homebrew',
      pm_winget: pm === 'winget',
    }
    logEvent('tengu_pkg_manager_auto_updater_start', pmMetadata)

    const [file, ...args] = argv
    const result = await execFileNoThrowWithCwd(file!, args, {
      // Run from the home dir: brew refuses to operate inside some repos, and
      // the project cwd may disappear mid-upgrade.
      cwd: homedir(),
      timeout: 300_000,
      env:
        pm === 'homebrew'
          ? { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '' }
          : undefined,
    })
    const latencyMs = Date.now() - startedAt

    onChangeIsUpdating(false)
    if (result.code === 0) {
      logEvent('tengu_pkg_manager_auto_updater_success', {
        ...pmMetadata,
        latency_ms: latencyMs,
      })
      onAutoUpdaterResult({ version: latest, status: 'success' })
    } else {
      logForDebugging(
        `PackageManagerAutoUpdater: ${file} exited ${result.code}: ${result.stderr || result.error || result.stdout}`,
      )
      logEvent('tengu_pkg_manager_auto_updater_fail', {
        ...pmMetadata,
        latency_ms: latencyMs,
        exit_code: result.code,
      })
      lastInstallFailedAt = Date.now()
      onAutoUpdaterResult({ version: latest, status: 'install_failed' })
    }
  }, [onChangeIsUpdating, onAutoUpdaterResult])

  // Initial check
  React.useEffect(() => {
    void checkForUpdates()
  }, [checkForUpdates])

  useInterval(checkForUpdates, CHECK_INTERVAL_MS)

  if (autoUpdaterResult?.status === 'success') {
    if (!showSuccessMessage) return null
    return (
      <Box flexDirection="row" gap={1}>
        {verbose && (
          <Text dimColor wrap="truncate">
            current: {MACRO.VERSION} · latest: {autoUpdaterResult.version}
          </Text>
        )}
        <Text color="success" wrap="truncate">
          ✓ Update installed
          {packageManager !== 'unknown' && ` via ${packageManager}`} · Restart
          to apply
        </Text>
      </Box>
    )
  }

  if (isUpdating) {
    return (
      <Text dimColor wrap="truncate">
        {packageManager === 'unknown'
          ? 'Updating…'
          : `Updating via ${packageManager}…`}
      </Text>
    )
  }

  const installFailed = autoUpdaterResult?.status === 'install_failed'
  if ((!updateVersion && !installFailed) || packageManager === 'unknown') {
    return null
  }

  return (
    <>
      {verbose && (
        <Text dimColor wrap="truncate">
          currentVersion: {MACRO.VERSION}
        </Text>
      )}
      <Text color="warning" wrap="truncate">
        Update available! Run:{' '}
        <Text bold>{getUpgradeHint(packageManager, caskName)}</Text>
        {installFailed && <Text dimColor> (auto-update failed)</Text>}
      </Text>
    </>
  )
}
