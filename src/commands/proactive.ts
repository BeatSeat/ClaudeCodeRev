/**
 * Official 2.1.105: `/proactive` is a bundled-skill alias of `/loop`
 * (`src/skills/bundled/loop.ts` aliases: ['proactive']). This module is
 * still imported behind PROACTIVE/KAIROS so the feature gate stays, but
 * must not register a second command that would shadow the skill.
 */
export default null
