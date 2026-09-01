import * as React from 'react'
import { Box, Text } from '../ink.js'
import {
  slugifyThemeName,
  writeCustomTheme,
  type CustomTheme,
} from '../utils/customThemes.js'
import type { ThemeName } from '../utils/theme.js'
import { THEME_NAMES } from '../utils/theme.js'
import { Select } from './CustomSelect/index.js'
import { Pane } from './design-system/Pane.js'

type Props = {
  initial?: CustomTheme
  defaultBase: ThemeName
  onDone: (theme: CustomTheme) => void
  onCancel: () => void
}

const BASE_OPTIONS = THEME_NAMES.map(name => ({
  label: name,
  value: name,
}))

export function CustomThemeEditor({
  initial,
  defaultBase,
  onDone,
  onCancel,
}: Props): React.ReactNode {
  const [name, setName] = React.useState(initial?.name ?? 'New custom theme')
  const [base, setBase] = React.useState<ThemeName>(
    initial?.base ?? defaultBase,
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function save(nextBase: ThemeName): Promise<void> {
    const slug = initial?.slug ?? slugifyThemeName(name)
    setSaving(true)
    setError(null)
    try {
      await writeCustomTheme({
        slug,
        name,
        base: nextBase,
        overrides: initial?.overrides ?? {},
      })
      onDone({
        slug,
        name,
        base: nextBase,
        overrides: initial?.overrides ?? {},
        source: 'user',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold color="permission">
          New custom theme
        </Text>
        <Text dimColor>
          Saved as JSON under ~/.claude/themes/. Pick a base palette.
        </Text>
        <Text>
          Name: {name}
        </Text>
        {error ? <Text color="error">{error}</Text> : null}
        <Select
          options={BASE_OPTIONS}
          defaultValue={base}
          onChange={value => {
            const next = value as ThemeName
            setBase(next)
            if (!saving) void save(next)
          }}
          onCancel={onCancel}
        />
      </Box>
    </Pane>
  )
}
