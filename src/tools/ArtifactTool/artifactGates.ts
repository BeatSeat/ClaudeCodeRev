/**
 * Official 2.1.172 (G2 — tengu_cobalt_plinth / tengu_cobalt_plinth_direct):
 * the artifact-publish eligibility gates. Tree-side equivalents of the
 * bundle's `qtH` module (minified `Q27`), a net-new product block in the
 * 2.1.170 → 2.1.172 hop.
 *
 * Minified → readable map (the "gate" half of the 13 added functions):
 *   B27 → isArtifactHardDisabled  (env / managed-settings kill switch)
 *   U27 → isArtifactSdkDefaultOff (SDK / GitHub-Action / MCP entrypoints)
 *   HtH → isArtifactToolEnabled   (the composite gate the tool + WebFetch use)
 *   F27 → isArtifactAdminAllowed  (pro/max block + allow_cobalt_plinth entitlement)
 *   $tH → isPublishToolEnabled    (alias of isArtifactToolEnabled)
 *
 * Gate wiring (which gates this feature hooks):
 *   - tengu_cobalt_plinth          — main publish gate, default false (HtH)
 *   - tengu_cobalt_plinth_direct   — direct-upload fast path, default false
 *                                      (see publishArtifact in artifactPublish.ts)
 *   - allow_cobalt_plinth          — admin entitlement (policy limits) in F27
 *   - CLAUDE_CODE_ARTIFACT         — explicit on/off env override
 *   - CLAUDE_CODE_DISABLE_ARTIFACT / settings.disableArtifact — hard disable
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'

/**
 * Official 2.1.172 `B27` — hard disable. Returns true when the Artifact
 * tool is force-disabled via the CLAUDE_CODE_DISABLE_ARTIFACT env or the
 * managed (policy) settings `disableArtifact` flag.
 */
export function isArtifactHardDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ARTIFACT) ||
    getSettingsForSource('policySettings')?.disableArtifact === true
  )
}

/**
 * Official 2.1.172 `U27` — true for the SDK / GitHub-Action / MCP
 * entrypoints, where the feature is default-OFF unless explicitly enabled
 * via CLAUDE_CODE_ARTIFACT (see isArtifactToolEnabled).
 */
export function isArtifactSdkDefaultOff(): boolean {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    entrypoint === 'sdk-ts' ||
    entrypoint === 'sdk-py' ||
    entrypoint === 'sdk-cli' ||
    entrypoint === 'claude-code-github-action' ||
    entrypoint === 'mcp'
  )
}

/**
 * Official 2.1.172 `F27` — the admin entitlement gate. Pro/Max subscribers
 * are blocked outright; everyone else is gated on the `allow_cobalt_plinth`
 * policy-limits entitlement.
 */
export function isArtifactAdminAllowed(): boolean {
  const tier = getSubscriptionType()
  // `tier === 'pro' || tier === 'max'` in the bundle; the tree's
  // SubscriptionType has no 'max' member, so compare the members that exist.
  if (tier === 'pro') {
    return false
  }
  return isPolicyAllowed('allow_cobalt_plinth')
}

/**
 * Official 2.1.172 `HtH` — the composite eligibility gate. This is the single
 * function the Artifact tool's isEnabled() and the WebFetch artifact-read
 * dispatch both call. Order of checks mirrors the bundle exactly:
 *
 *   hard-disable → claude.ai auth → firstParty provider → entrypoint
 *   (local-agent / claude-coworker*) → essential-traffic-only →
 *   CLAUDE_CODE_ARTIFACT off → (not explicitly on in an SDK default-off
 *   entrypoint) → tengu_cobalt_plinth → allow_cobalt_plinth.
 */
export function isArtifactToolEnabled(): boolean {
  if (isArtifactHardDisabled()) {
    return false
  }
  // `Gq()` in the bundle — a live claude.ai OAuth account (artifact pages are
  // hosted on claude.ai). Tree equivalent is isClaudeAISubscriber().
  if (!isClaudeAISubscriber()) {
    return false
  }
  if (getAPIProvider() !== 'firstParty') {
    return false
  }
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  if (entrypoint === 'local-agent' || entrypoint?.startsWith('claude-coworker')) {
    return false
  }
  if (isEssentialTrafficOnly()) {
    return false
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ARTIFACT)) {
    return false
  }
  const explicitlyEnabled = isEnvTruthy(process.env.CLAUDE_CODE_ARTIFACT)
  if (!explicitlyEnabled && isArtifactSdkDefaultOff()) {
    return false
  }
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_plinth', false)) {
    return false
  }
  return isArtifactAdminAllowed()
}

/**
 * Official 2.1.172 `$tH` — isPublishToolEnabled. A thin alias of
 * isArtifactToolEnabled (the bundle literally returns `HtH()`).
 */
export function isPublishToolEnabled(): boolean {
  return isArtifactToolEnabled()
}
