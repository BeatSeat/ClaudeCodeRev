/**
 * Artifact-publish ("cobalt_plinth") — 2.1.174 versioning increment.
 *
 * This module carries ONLY the 2.1.174 delta on top of the 2.1.172 base feature
 * (the artifact-publish / "cobalt_plinth" tool first introduced in 2.1.172).
 *
 * 172 base (NOT in this tree; must land first via its own 172 patch):
 *   - gate `tengu_cobalt_plinth` / `tengu_cobalt_plinth_direct`
 *   - `H04` (field mapper, incl. `favicon`), `$04` (publish), `eG4` (direct upload)
 *   - `R_f` (GCS PUT), `tG4` (deploy/complete), `q04` (url), `Xx` (err result)
 *   - `J7$` (error-body summary), `gYH` (16MB cap), `h_f` (style), `S_f`/`D7$`/`E_f`
 *
 * 174 delta (THIS module, firstSeen `tengu_cobalt_plinth_fern` = 2.1.174):
 *   - gate `tengu_cobalt_plinth_fern` (default `false`)
 *   - `baseVersion` threaded into the deploy/init and deploy/direct requests
 *   - HTTP 409 -> conflict -> read `liveVersion` -> prompt to reconcile
 *   - `K04` user-visible conflict copy
 *   - `_04` conflict-body parser
 *
 * Gate + defaults + copy + constants are aligned verbatim to the official 2.1.174
 * bundle (restore-work/artifacts/cometix/2.1.174/cli.js):
 *   function tHq(){return M$("tengu_cobalt_plinth_fern",!1)}
 *   var K04="conflict: another session published a newer version of this artifact. Re-read the current content (WebFetch the URL), reconcile your edits, then publish again.";
 *   function _04(H){if(H&&typeof H==="object"&&"conflict"in H&&H.conflict===!0&&"live"in H&&typeof H.live==="string")return H.live;return null}
 *   Y=z?$.baseVersion:void 0   (z = fern gate)
 *   ...Y&&{baseVersion:Y}      (deploy/init + deploy/direct)
 *   if(z&&J.status===409){let V=_04(J.data);if(V)return CH("artifact_publish","conflict"),{...Xx(K04),liveVersion:V}}
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

// Official 2.1.174 `tHq`: pure-constant gate read, default `false`.
//   function tHq(){return M$("tengu_cobalt_plinth_fern",!1)}
//   M$ is the tree's getFeatureValue_CACHED_MAY_BE_STALE.
export function isArtifactVersioningEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_plinth_fern', false)
}

/**
 * Official 2.1.174 `K04` — user-visible conflict copy, verbatim.
 */
export const ARTIFACT_VERSION_CONFLICT_MESSAGE =
  'conflict: another session published a newer version of this artifact. ' +
  'Re-read the current content (WebFetch the URL), reconcile your edits, then publish again.'

/**
 * Shape of the artifact-publish result produced by the 172 base
 * (`Xx` error factory + the 174 `liveVersion` add-on). Kept here so the
 * 174 delta can be applied to a result without importing the 172 base.
 */
export type ArtifactPublishResult = {
  url: string | null
  slug: string | null
  version: string | null
  err: string | null
  // 174: present only on the conflict / upload-failure fallback paths.
  liveVersion?: string | null
}

/**
 * Official 2.1.174 `_04` — parse the server 409 conflict body, verbatim.
 * Returns the newer live version string when the body is a well-formed
 * conflict response, else `null`.
 *
 *   function _04(H){
 *     if(H&&typeof H==="object"&&"conflict"in H&&H.conflict===!0
 *        &&"live"in H&&typeof H.live==="string")return H.live;
 *     return null
 *   }
 */
export function extractLiveVersionFromConflictBody(body: unknown): string | null {
  if (
    body &&
    typeof body === 'object' &&
    'conflict' in body &&
    (body as { conflict: unknown }).conflict === true &&
    'live' in body &&
    typeof (body as { live: unknown }).live === 'string'
  ) {
    return (body as { live: string }).live
  }
  return null
}

/**
 * 174 `baseVersion` threading.
 *
 *   let z=tHq(), Y=z?$.baseVersion:void 0
 *
 * When the fern gate is on, the publish request's `baseVersion` is taken from
 * the caller-provided `input.baseVersion`; when off, it is `undefined` and the
 * spread `...Y&&{baseVersion:Y}` contributes nothing (172 behaviour).
 */
export function resolveBaseVersion(
  fernEnabled: boolean,
  input: { baseVersion?: string | null | undefined },
): string | undefined {
  return fernEnabled ? (input.baseVersion ?? undefined) : undefined
}

/**
 * Build the JSON body fragment for `POST /api/frame/deploy/init` and
 * `POST /api/frame/deploy/direct`, applying the 174 `baseVersion` delta.
 *
 * 174 bundle:
 *   post("/api/frame/deploy/init",{...H04(O),...V&&A&&{mcp:A},...Y&&{baseVersion:Y}},...)
 *   post("/api/frame/deploy/direct",{...H04($),...w&&q&&{mcp:q},..._&&{baseVersion:_},content:H},...)
 *
 * `fieldMapper` is the 172 base `H04` (slug/title/favicon/label); `mcp`/`mcpSent`
 * and `content` (direct only) are 172-base fields threaded through unchanged.
 * Only the trailing `...Y&&{baseVersion:Y}` is the 174 delta this module owns.
 */
export function buildPublishPayload(options: {
  // 172 base `H04(O)` — the field mapper (slug/title/favicon/label).
  fieldMapper: Record<string, unknown>
  // 172 base: include `mcp` only when it was actually sent in the first attempt.
  mcpSent: boolean
  mcp: string | null | undefined
  // 174 delta: resolved `baseVersion` (undefined => not included).
  baseVersion: string | undefined
  // direct-upload only: the rendered page body.
  content?: string
}): Record<string, unknown> {
  const { fieldMapper, mcpSent, mcp, baseVersion, content } = options
  const payload: Record<string, unknown> = { ...fieldMapper }
  if (mcpSent && mcp) {
    payload.mcp = mcp
  }
  if (baseVersion) {
    payload.baseVersion = baseVersion
  }
  if (content !== undefined) {
    payload.content = content
  }
  return payload
}

/**
 * 174 `409 -> conflict -> read liveVersion -> reconcile` handling.
 *
 * 174 bundle (deploy/init):
 *   if(z&&J.status===409){
 *     let V=_04(J.data);
 *     if(V)return CH("artifact_publish","conflict"),{...Xx(K04),liveVersion:V}
 *   }
 * 174 bundle (deploy/direct, same shape):
 *   if(_&&A.status===409){
 *     let w=_04(A.data);
 *     if(w)return CH("artifact_publish","conflict"),{...Xx(K04),liveVersion:w}
 *   }
 *
 * Returns the conflict result (a non-null err carrying `K04` plus the newer
 * `liveVersion`) when the fern gate is on, the status is 409, and the body
 * parses as a conflict; otherwise `null` (caller continues with the normal
 * error / success flow).
 *
 * The caller is responsible for the `CH("artifact_publish","conflict")`
 * (artifact_publish/conflict) analytics marker and the `Xx(K04)` err factory,
 * which live on the 172 base; the returned `liveVersion` and the `K04` copy are
 * the 174-owned values exposed here.
 */
export function handleVersionConflict(
  fernEnabled: boolean,
  httpStatus: number,
  body: unknown,
): { err: string; liveVersion: string } | null {
  if (!fernEnabled || httpStatus !== 409) {
    return null
  }
  const liveVersion = extractLiveVersionFromConflictBody(body)
  if (!liveVersion) {
    return null
  }
  return { err: ARTIFACT_VERSION_CONFLICT_MESSAGE, liveVersion }
}
