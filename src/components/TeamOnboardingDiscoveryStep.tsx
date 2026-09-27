import * as React from 'react'
import { TEAM_ONBOARDING_DISCOVERY_COPY } from '../commands/team-onboarding/discovery.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { Box, Text } from '../ink.js'
import { Clawd } from './LogoV2/Clawd.js'
import { PressEnterToContinue } from './PressEnterToContinue.js'

type Props = {
  onDone: () => void
}

/** Official 2.1.94 zKO — extra first-run step when cedar_inlet === "step". */
export function TeamOnboardingDiscoveryStep({
  onDone,
}: Props): React.ReactNode {
  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' })

  return (
    <Box flexDirection="column">
      <Clawd />
      <Box flexDirection="column" gap={1} paddingLeft={1} marginTop={1}>
        <Text bold>{TEAM_ONBOARDING_DISCOVERY_COPY.heading}</Text>
        <Box width={70}>
          <Text>{TEAM_ONBOARDING_DISCOVERY_COPY.body}</Text>
        </Box>
        <PressEnterToContinue />
      </Box>
    </Box>
  )
}
