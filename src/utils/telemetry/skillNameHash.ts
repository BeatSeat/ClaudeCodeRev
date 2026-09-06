/**
 * Official 2.1.178 `e_5` / `meH` — skill analytics name + hash.
 * `AT$` is `hashPluginId(name)` (sha256 + `claude-plugin-telemetry-v1`).
 */
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { hashPluginId } from './pluginTelemetry.js'

export type SkillNameHashFields = {
  skill_name_hash?: string
}

/**
 * Official 2.1.178 `e_5`. Only custom skills get `skill_name_hash`.
 */
export function skillNameHashFields(
  canonicalName: string,
  kind: string,
): SkillNameHashFields {
  if (kind !== 'custom') return {}
  return {
    skill_name_hash: sanitizeToolNameForAnalytics(hashPluginId(canonicalName)),
  }
}

/**
 * Official 2.1.178 `meH`.
 * `sanitizedName` is `mcp` / the raw name / `custom`.
 */
export function getSkillAnalyticsName(opts: {
  rawName: string
  canonicalName: string
  isMcp: boolean
  isBuiltIn: boolean
  isBundled: boolean
  isOfficial: boolean
}): {
  sanitizedName: ReturnType<typeof sanitizeToolNameForAnalytics>
  skillNameHash: SkillNameHashFields
} {
  const kind = opts.isMcp
    ? 'mcp'
    : opts.isBuiltIn || opts.isBundled || opts.isOfficial
      ? opts.rawName
      : 'custom'
  return {
    sanitizedName: sanitizeToolNameForAnalytics(kind),
    skillNameHash: skillNameHashFields(opts.canonicalName, kind),
  }
}
