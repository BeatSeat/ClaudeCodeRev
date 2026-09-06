import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { CustomThemeEditor } from '../../components/CustomThemeEditor.js'
import { Pane } from '../../components/design-system/Pane.js'
import { ThemePicker } from '../../components/ThemePicker.js'
import { useCustomThemes, useTheme, useThemeSetting } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  customThemeSlug,
  toCustomThemeSetting,
} from '../../utils/customThemes.js'
import type { CustomTheme } from '../../utils/customThemes.js'
import { isSafeMode } from '../../utils/envUtils.js'
import { getSafeModeOffHint } from '../../utils/safeModeHint.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type View =
  | { kind: 'picker' }
  | { kind: 'editor'; initial?: CustomTheme }

function ThemePickerCommand({ onDone }: Props): React.ReactNode {
  const [currentTheme, setTheme] = useTheme()
  const { customThemes, reloadCustomThemes } = useCustomThemes()
  const [view, setView] = React.useState<View>({ kind: 'picker' })
  // Official 2.1.169 safe mode: custom theme create/edit is disabled and the
  // picker explains why (bundle pBf: `K1("themes")` ≡ safe mode for themes).
  const customThemesDisabled = isSafeMode()
  const themeSetting = useThemeSetting()
  const savedCustomThemeSlug = customThemeSlug(themeSetting)

  if (view.kind === 'editor') {
    return (
      <CustomThemeEditor
        initial={view.initial}
        defaultBase={currentTheme}
        onDone={theme => {
          reloadCustomThemes()
          setTheme(toCustomThemeSetting(theme.slug))
          onDone(`Using custom theme "${theme.name}"`)
        }}
        onCancel={() => setView({ kind: 'picker' })}
      />
    )
  }

  return (
    <Pane color="permission">
      <ThemePicker
        onThemeSelect={setting => {
          setTheme(setting)
          const slug = customThemeSlug(setting)
          if (slug) {
            const named = customThemes.find(t => t.slug === slug)
            onDone(`Using custom theme "${named?.name ?? setting}"`)
            return
          }
          onDone(`Theme set to ${setting}`)
        }}
        onCustomTheme={
          customThemesDisabled
            ? undefined
            : initial => setView({ kind: 'editor', initial })
        }
        helpText={
          customThemesDisabled
            ? `Custom themes are disabled in safe mode — ${getSafeModeOffHint()} to create or edit them${savedCustomThemeSlug ? `. Your saved theme "${savedCustomThemeSlug}" is a custom theme; selecting a preset here replaces it` : ''}`
            : ''
        }
        onCancel={() => {
          onDone('Theme picker dismissed', { display: 'system' })
        }}
        skipExitHandling={true}
      />
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <ThemePickerCommand onDone={onDone} />
}
