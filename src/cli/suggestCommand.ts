import figures from 'figures'
import chalk from 'chalk'
import type { Command } from '@commander-js/extra-typings'
import { logEvent } from '../services/analytics/index.js'
import { shutdownDatadog } from '../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../services/analytics/firstPartyEventLogger.js'
import { closestCommandName } from '../utils/fuzzyCommandMatch.js'
import { sleep } from '../utils/sleep.js'

/**
 * Official 2.1.111 HPA: when `claude <typo>` looks like a subcommand
 * (e.g. `claude udpate`), suggest the closest registered command.
 */
export async function suggestClosestCliCommand(
  input: string,
  program: Command,
): Promise<void> {
  const names = program.commands
    .filter(cmd => !('_hidden' in cmd && cmd._hidden))
    .flatMap(cmd => [cmd.name(), ...cmd.aliases()])
  const lower = input.toLowerCase()
  const suggestion =
    lower !== input && names.includes(lower)
      ? lower
      : closestCommandName(
          lower,
          names.map(name => ({ name })),
        )
  if (!suggestion) {
    return
  }
  logEvent('tengu_unknown_command_suggestion', {})
  process.stderr.write(
    [
      chalk.red(figures.cross) + ` unknown command "${input}"`,
      chalk.dim(`  ${figures.lineUpRight} `) +
        'Did you mean ' +
        chalk.bold(`claude ${suggestion}`) +
        '?',
      '',
      chalk.dim('Run ') +
        chalk.dim.bold('claude --help') +
        chalk.dim(' to list commands, or ') +
        chalk.dim.bold(`claude -p "${input}"`) +
        chalk.dim(' to send as a prompt.'),
      '',
    ].join('\n'),
  )
  try {
    await Promise.race([
      Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
      sleep(500, undefined, { unref: true }),
    ])
  } catch {
    // Best-effort flush before exit.
  }
  process.exit(1)
}
