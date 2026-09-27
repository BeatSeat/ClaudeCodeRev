import { spawn } from 'child_process'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getRelaunchSpec, severTtyInputForRelaunch } from '../../utils/relaunch.js'
import { createRoot } from '../../ink.js'
import { mountFleetView } from './mountFleetView.js'

type Meta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

/**
 * Official 2.1.119 `FW4` / `uW4` leftover.
 * Logs `tengu_open_agents_via_left`, then either mounts FleetView in-process
 * (`tengu_bg_leftarrow_inprocess`) or execs `claude agents`.
 */
export async function openAgentsViaLeft(
  currentInput: string | null,
): Promise<string | undefined> {
  logForDebugging('[PERF:bg-leftarrow-start]')
  const wasEmpty = currentInput === null || currentInput.trim() === ''
  logEvent('tengu_open_agents_via_left', {
    was_empty: wasEmpty as unknown as Meta,
  })
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bg_leftarrow_inprocess', true)) {
    try {
      return await mountFleetViewInProcess()
    } catch (err) {
      logError(err)
    }
  }
  return spawnAgentsCli()
}

async function mountFleetViewInProcess(): Promise<undefined> {
  logForDebugging('[PERF:bg-leftarrow-mounted]')
  const root = await createRoot({ exitOnCtrlC: false })
  await mountFleetView(root)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(0)
}

async function spawnAgentsCli(): Promise<undefined> {
  const { cmd, prefixArgs } = getRelaunchSpec()
  const child = spawn(cmd, [...prefixArgs, 'agents'], {
    stdio: 'inherit',
    env: { ...process.env },
  })
  severTtyInputForRelaunch()
  await new Promise<never>(() => {
    child.on('close', (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0))
    })
    child.on('error', err => {
      process.stderr.write(`Failed to open agents: ${err.message}\n`)
      process.exit(1)
    })
  })
}
