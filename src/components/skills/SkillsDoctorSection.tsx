import React, { useEffect, useState } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getSkillToolCommands } from '../../commands.js'
import { Box, Text } from '../../ink.js'
import { MAX_LISTING_DESC_CHARS } from '../../tools/SkillTool/prompt.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'
import { DoctorSectionTitle } from '../design-system/DoctorSectionTitle.js'
import { List } from '../design-system/List.js'

/**
 * Official 2.1.178 `v49` — skill-listing cap warning (TZ/XK/C8).
 * Full budget-mode store (`sgf`) is not on HEAD; this lands the per-entry
 * cap copy when descriptions exceed `skillListingMaxDescChars`.
 */
export function SkillsDoctorSection(): React.ReactNode {
  const [capped, setCapped] = useState<string[]>([])
  const [cap, setCap] = useState(MAX_LISTING_DESC_CHARS)

  useEffect(() => {
    const max =
      getInitialSettings().skillListingMaxDescChars ?? MAX_LISTING_DESC_CHARS
    setCap(max)
    void getSkillToolCommands(getOriginalCwd()).then(cmds => {
      setCapped(
        cmds
          .filter(cmd => {
            const desc = cmd.whenToUse
              ? `${cmd.description} - ${cmd.whenToUse}`
              : cmd.description
            return (desc?.length ?? 0) > max
          })
          .map(cmd => cmd.name),
      )
    })
  }, [])

  if (capped.length === 0) return null

  const names = capped.join(', ')

  return (
    <Box flexDirection="column" marginTop={1}>
      <DoctorSectionTitle title="Skills" status="warning" />
      <List variant="tree">
        <List.Group>
          <List.Node color="warning">
            {`${capped.length} skill ${plural(capped.length, 'description exceeds', 'descriptions exceed')} the per-entry cap and will be shortened: ${names}`}
          </List.Node>
          <List.Node dimColor>
            raise <Text color="suggestion">skillListingMaxDescChars</Text>{' '}
            (currently {cap}) in settings.json
          </List.Node>
        </List.Group>
      </List>
    </Box>
  )
}
