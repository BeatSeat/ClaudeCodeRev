import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { isDesignSyncEnabled } from '../../tools/DesignSyncTool/auth.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { DESIGN_SYNC_FILES, DESIGN_SYNC_SKILL_MD } from './designSyncFiles.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(DESIGN_SYNC_SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Push a React design system to claude.ai/design'

/**
 * Official 2.1.160 `aJ9`. Same `x08` gate as DesignSyncTool.
 * `Rb8` / `initBundledSkills` calls this first.
 */
export function registerDesignSyncSkill(): void {
  registerBundledSkill({
    name: 'design-sync',
    description: DESCRIPTION,
    isEnabled: isDesignSyncEnabled,
    argumentHint: '[<project hint, e.g. "Acme DS">]',
    disableModelInvocation: true,
    userInvocable: true,
    files: DESIGN_SYNC_FILES,
    async getPromptForCommand(args) {
      const parts = [SKILL_BODY.trimStart()]
      if (args?.trim()) {
        parts.push(`## Hint\n\n\`\`\`\n${args.trim()}\n\`\`\``)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
