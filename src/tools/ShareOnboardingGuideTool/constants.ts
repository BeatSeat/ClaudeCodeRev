/** Official 2.1.128 iw$ — the tool name as seen by the model. */
export const SHARE_ONBOARDING_GUIDE_TOOL_NAME = 'ShareOnboardingGuide'

/** Official 2.1.128 — one-line ToolSearch keyword hint. */
export const SHARE_ONBOARDING_GUIDE_SEARCH_HINT =
  'upload ONBOARDING.md and get a team share link'

/** Official 2.1.128 L26 — the onboarding guide file the tool uploads. */
export const ONBOARDING_FILE_NAME = 'ONBOARDING.md'

/** Official 2.1.128 px7 — reject guides over this many bytes (64 KB). */
export const MAX_ONBOARDING_SIZE_BYTES = 65536

/**
 * Official 2.1.128 J26 — shared by both `description()` and `prompt()`.
 * Verbatim from the bundle.
 */
export const SHARE_ONBOARDING_GUIDE_PROMPT = `Upload the ONBOARDING.md in the current directory and return a share link teammates can open in Claude Code. Call this after the user has confirmed the final content.

If a guide already exists for this org and you have not yet asked the user, the tool returns its share link without uploading. Ask the user whether to update that link or create a new one, then call again with the chosen mode.`
