import React from 'react'
import { Select } from 'src/components/CustomSelect/index.js'
import { Box, Text } from '../../ink.js'

type SetupActionsChoice = 'setup' | 'skip'

interface SetupActionsPromptStepProps {
  onSelect: (choice: SetupActionsChoice) => void
  onCancel: () => void
}

export function SetupActionsPromptStep({
  onSelect,
  onCancel,
}: SetupActionsPromptStepProps): React.ReactNode {
  const options = [
    {
      label: 'Set up GitHub Actions workflows',
      value: 'setup',
    },
    {
      label: 'Skip for now (you can run /install-github-app again later)',
      value: 'skip',
    },
  ]

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>GitHub App installed!</Text>
        <Text dimColor>Set up GitHub Actions</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {
            'The Claude GitHub App is now installed. You can optionally set up GitHub Actions workflows so Claude responds to @claude mentions in issues and PRs.'
          }
        </Text>
      </Box>
      <Box flexDirection="column">
        <Select
          options={options}
          onChange={value => onSelect(value as SetupActionsChoice)}
          onCancel={onCancel}
        />
      </Box>
    </Box>
  )
}
