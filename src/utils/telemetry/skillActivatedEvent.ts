import { isToolDetailsLoggingEnabled } from '../../services/analytics/metadata.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from '../plugins/pluginIdentifier.js'
import { logOTelEvent } from './events.js'

type SkillActivatedCommand = {
  type?: string
  source?: string
  pluginInfo?: {
    pluginManifest: { name: string }
    repository: string
  }
  kind?: string
}

/**
 * Official 2.1.126 `F_$` (123 `WZ7` + `invocation_trigger`).
 * OTEL `claude_code.skill_activated`.
 */
export function logOTelSkillActivated(
  skillName: string,
  command: SkillActivatedCommand | undefined,
  invocationTrigger: string,
): void {
  const source = command?.type === 'prompt' ? command.source : undefined
  const pluginInfo =
    command?.type === 'prompt' ? command.pluginInfo : undefined
  const marketplace = pluginInfo
    ? parsePluginIdentifier(pluginInfo.repository).marketplace
    : undefined
  const unredacted =
    source === 'builtin' ||
    source === 'bundled' ||
    (source === 'plugin' && isOfficialMarketplaceName(marketplace)) ||
    isToolDetailsLoggingEnabled()
  void logOTelEvent('skill_activated', {
    'skill.name': unredacted ? skillName : 'custom_skill',
    invocation_trigger: invocationTrigger,
    ...(source && { 'skill.source': source }),
    ...(command?.kind && { 'skill.kind': command.kind }),
    ...(unredacted &&
      pluginInfo && { 'plugin.name': pluginInfo.pluginManifest.name }),
    ...(unredacted && marketplace && { 'marketplace.name': marketplace }),
  })
}
