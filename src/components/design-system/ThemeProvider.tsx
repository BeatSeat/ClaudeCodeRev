import { feature } from 'bun:bundle'
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import useStdin from '../../ink/hooks/use-stdin.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  customThemeSlug,
  isBuiltInThemeName,
  loadCustomThemes,
  mergeTheme,
  type CustomTheme,
  watchUserThemes,
} from '../../utils/customThemes.js'
import {
  getSystemThemeName,
  type SystemTheme,
} from '../../utils/systemTheme.js'
import { getTheme, type Theme, type ThemeName, type ThemeSetting } from '../../utils/theme.js'

type ThemeContextValue = {
  /** The saved user preference. May be 'auto'. */
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
  /** The resolved theme to render with. Never 'auto'. */
  currentTheme: ThemeName
  resolvedTheme: Theme
  customThemes: CustomTheme[]
  activeCustomTheme: CustomTheme | undefined
  reloadCustomThemes: () => void
  setPreviewOverrides: (overrides: Partial<Theme> | null) => void
}

// Non-'auto' default so useTheme() works without a provider (tests, tooling).
const DEFAULT_THEME: ThemeName = 'dark'

const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  currentTheme: DEFAULT_THEME,
  resolvedTheme: getTheme(DEFAULT_THEME),
  customThemes: [],
  activeCustomTheme: undefined,
  reloadCustomThemes: () => {},
  setPreviewOverrides: () => {},
})

type Props = {
  children: React.ReactNode
  initialState?: ThemeSetting
  onThemeSave?: (setting: ThemeSetting) => void
}

function defaultInitialTheme(): ThemeSetting {
  return getGlobalConfig().theme
}

function defaultSaveTheme(setting: ThemeSetting): void {
  saveGlobalConfig(current => ({ ...current, theme: setting }))
}

export function ThemeProvider({
  children,
  initialState,
  onThemeSave = defaultSaveTheme,
}: Props) {
  const [themeSetting, setThemeSetting] = useState(
    initialState ?? defaultInitialTheme,
  )
  const [previewTheme, setPreviewTheme] = useState<ThemeSetting | null>(null)
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(loadCustomThemes)
  const [previewOverrides, setPreviewOverrides] = useState<Partial<Theme> | null>(
    null,
  )

  const reloadCustomThemes = useCallback((): void => {
    setCustomThemes(loadCustomThemes())
  }, [])

  useEffect(() => {
    return watchUserThemes(reloadCustomThemes)
  }, [])

  // Track terminal theme for 'auto' resolution. Seeds from $COLORFGBG (or
  // 'dark' if unset); the OSC 11 watcher corrects it on first poll.
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(() =>
    (initialState ?? themeSetting) === 'auto' ? getSystemThemeName() : 'dark',
  )

  // The setting currently in effect (preview wins while picker is open)
  const activeSetting = previewTheme ?? themeSetting

  const { internal_querier } = useStdin()

  // Watch for live terminal theme changes while 'auto' is active.
  // Positive feature() pattern so the watcher import is dead-code-eliminated
  // in external builds.
  useEffect(() => {
    if (feature('AUTO_THEME')) {
      if (activeSetting !== 'auto' || !internal_querier) return
      let cleanup: (() => void) | undefined
      let cancelled = false
      void import('../../utils/systemThemeWatcher.js').then(
        ({ watchSystemTheme }) => {
          if (cancelled) return
          cleanup = watchSystemTheme(internal_querier, setSystemTheme)
        },
      )
      return () => {
        cancelled = true
        cleanup?.()
      }
    }
  }, [activeSetting, internal_querier])

  const customSlug = customThemeSlug(activeSetting)
  const activeCustomTheme = customSlug
    ? customThemes.find(t => t.slug === customSlug)
    : undefined

  const currentTheme: ThemeName =
    activeCustomTheme
      ? activeCustomTheme.base
      : activeSetting === 'auto'
        ? systemTheme
        : isBuiltInThemeName(activeSetting)
          ? activeSetting
          : customSlug
            ? 'dark'
            : DEFAULT_THEME

  const resolvedTheme = useMemo(
    () =>
      mergeTheme(
        getTheme(currentTheme),
        previewOverrides ?? activeCustomTheme?.overrides,
      ),
    [currentTheme, previewOverrides, activeCustomTheme],
  )

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeSetting,
      setThemeSetting: (newSetting: ThemeSetting) => {
        setThemeSetting(newSetting)
        setPreviewTheme(null)
        setPreviewOverrides(null)
        // Switching to 'auto' restarts the watcher (activeSetting dep), whose
        // first poll fires immediately. Seed from the cache so the OSC
        // round-trip doesn't flash the wrong palette.
        if (newSetting === 'auto') {
          setSystemTheme(getSystemThemeName())
        }
        onThemeSave?.(newSetting)
      },
      setPreviewTheme: (newSetting: ThemeSetting) => {
        setPreviewTheme(newSetting)
        if (newSetting === 'auto') {
          setSystemTheme(getSystemThemeName())
        }
      },
      savePreview: () => {
        if (previewTheme !== null) {
          setThemeSetting(previewTheme)
          setPreviewTheme(null)
          onThemeSave?.(previewTheme)
        }
      },
      cancelPreview: () => {
        if (previewTheme !== null) {
          setPreviewTheme(null)
        }
      },
      currentTheme,
      resolvedTheme,
      customThemes,
      activeCustomTheme,
      reloadCustomThemes,
      setPreviewOverrides,
    }),
    [
      themeSetting,
      previewTheme,
      currentTheme,
      resolvedTheme,
      customThemes,
      activeCustomTheme,
      reloadCustomThemes,
      onThemeSave,
    ],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * Returns the resolved theme for rendering (never 'auto') and a setter that
 * accepts any ThemeSetting (including 'auto').
 */
export function useTheme(): [ThemeName, (setting: ThemeSetting) => void] {
  const { currentTheme, setThemeSetting } = useContext(ThemeContext)
  return [currentTheme, setThemeSetting]
}

/**
 * Returns the raw theme setting as stored in config. Use this in UI that
 * needs to show 'auto' as a distinct choice (e.g., ThemePicker).
 */
export function useThemeSetting(): ThemeSetting {
  return useContext(ThemeContext).themeSetting
}

export function usePreviewTheme() {
  const { setPreviewTheme, savePreview, cancelPreview } =
    useContext(ThemeContext)
  return { setPreviewTheme, savePreview, cancelPreview }
}

/** Official 2.1.118 W4H */
export function useCustomThemes(): {
  customThemes: CustomTheme[]
  activeCustomTheme: CustomTheme | undefined
  reloadCustomThemes: () => void
  setPreviewOverrides: (overrides: Partial<Theme> | null) => void
} {
  const {
    customThemes,
    activeCustomTheme,
    reloadCustomThemes,
    setPreviewOverrides,
  } = useContext(ThemeContext)
  return {
    customThemes,
    activeCustomTheme,
    reloadCustomThemes,
    setPreviewOverrides,
  }
}

export function useResolvedTheme(): Theme {
  return useContext(ThemeContext).resolvedTheme
}
