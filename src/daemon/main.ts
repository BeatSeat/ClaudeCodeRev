import {
  fleetGateRejected,
  isDaemonCliEnabled,
} from '../components/FleetView/fleetGate.js'
import { parseDaemonArgs, runDaemonCommand } from './bg/cli.js'

/**
 * Official 2.1.119 `Pz5`. `isDaemonCliEnabled` is `() => false`, so every
 * subcommand except internal `run` (supervisor child) is rejected.
 */
export async function daemonMain(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    if (!isDaemonCliEnabled()) fleetGateRejected('daemon')
    return
  }
  const parsed = parseDaemonArgs(args)
  if (parsed.sub !== 'run' && !isDaemonCliEnabled()) {
    fleetGateRejected('daemon')
  }
  await runDaemonCommand(args)
}
