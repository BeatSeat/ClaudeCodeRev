import React from 'react'
import { Box, Text } from '../../ink.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { DoctorSectionTitle } from '../design-system/DoctorSectionTitle.js'
import { List } from '../design-system/List.js'

/** Official 2.1.178 `E49` — TZ title + XK tree + `/sandbox` highlight. */
export function SandboxDoctorSection(): React.ReactNode {
  if (!SandboxManager.isSupportedPlatform()) {
    return null
  }

  if (!SandboxManager.isSandboxEnabledInSettings()) {
    return null
  }

  if (!SandboxManager.isPlatformInEnabledList()) {
    return null
  }

  const depCheck = SandboxManager.checkDependencies()
  const hasErrors = depCheck.errors.length > 0
  const hasWarnings = depCheck.warnings.length > 0

  if (!hasErrors && !hasWarnings) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <DoctorSectionTitle
        title="Sandbox"
        status={hasErrors ? 'error' : 'warning'}
      />
      <List variant="tree">
        {depCheck.errors.map((e, i) => (
          <List.Node key={`e-${i}`} color="error">
            {e}
          </List.Node>
        ))}
        {depCheck.warnings.map((w, i) => (
          <List.Node key={`w-${i}`} color="warning">
            {w}
          </List.Node>
        ))}
        {hasErrors && (
          <List.Node dimColor>
            Run <Text color="suggestion">/sandbox</Text> for install
            instructions
          </List.Node>
        )}
      </List>
    </Box>
  )
}
