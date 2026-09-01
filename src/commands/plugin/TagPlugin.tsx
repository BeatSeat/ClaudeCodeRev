import figures from 'figures'
import * as React from 'react'
import { useEffect } from 'react'
import { Box, Text } from '../../ink.js'
import {
  createPluginTag,
  formatPluginTagDryRun,
  planPluginTag,
  PLUGIN_TAG_USAGE,
} from '../../utils/plugins/pluginTag.js'

type Props = {
  onComplete: (result?: string) => void
  path?: string
  push?: boolean
  dryRun?: boolean
  force?: boolean
  unknownFlag?: string
}

export function TagPlugin({
  onComplete,
  path,
  push,
  dryRun,
  force,
  unknownFlag,
}: Props): React.ReactNode {
  useEffect(() => {
    async function run(): Promise<void> {
      if (unknownFlag !== undefined) {
        onComplete(
          unknownFlag === '--help' || unknownFlag === '-h'
            ? PLUGIN_TAG_USAGE
            : `${figures.cross} Unexpected argument "${unknownFlag}".\n\n${PLUGIN_TAG_USAGE}`,
        )
        return
      }
      const planned = await planPluginTag(path ?? '.', { force })
      const lines = planned.warnings.map(w => `${figures.warning} ${w}`)
      if ('error' in planned) {
        lines.push(`${figures.cross} ${planned.error}`)
        onComplete(lines.join('\n'))
        return
      }
      const { plan } = planned
      lines.push(`Plugin:  ${plan.pluginName}`)
      lines.push(`Version: ${plan.version} (from ${plan.versionFrom})`)
      if (plan.marketplace) {
        lines.push(
          `Marketplace entry: plugins[${plan.marketplace.entryIndex}] in ${plan.marketplace.path}` +
            (plan.marketplace.entryVersion
              ? ` (version: ${plan.marketplace.entryVersion})`
              : ''),
        )
      }
      lines.push(`Tag:     ${plan.tag}`, '')
      const pushCmd = `git -C ${plan.gitRoot} push ${force ? '--force ' : ''}origin refs/tags/${plan.tag}`
      if (dryRun) {
        const [head, ...rest] = formatPluginTagDryRun(plan, {
          force,
          message: undefined,
        })
        lines.push(`${figures.tick} ${head}`, ...rest)
        onComplete(lines.join('\n'))
        return
      }
      const created = await createPluginTag(plan, {
        push: push ?? false,
        force: force ?? false,
        message: undefined,
        remote: 'origin',
      })
      if ('error' in created) {
        lines.push(`${figures.cross} ${created.error}`)
        onComplete(lines.join('\n'))
        return
      }
      lines.push(`${figures.tick} Created tag ${plan.tag}`)
      lines.push(
        created.pushed
          ? `${figures.tick} Pushed to origin`
          : `  Push with: ${pushCmd}`,
      )
      lines.push(
        '',
        'For -m/--message and --remote, use: claude plugin tag --help',
      )
      onComplete(lines.join('\n'))
    }
    void run()
  }, [onComplete, path, push, dryRun, force, unknownFlag])

  return (
    <Box flexDirection="column">
      <Text>Preparing tag…</Text>
    </Box>
  )
}
