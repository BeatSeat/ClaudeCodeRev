import { mkdir, writeFile } from 'fs/promises'
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'fs'
import { basename, extname, join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { getTheme, THEME_NAMES, type Theme, type ThemeName } from './theme.js'
import { errorMessage } from './errors.js'

export const CUSTOM_THEME_PREFIX = 'custom:'
const MAX_THEME_BYTES = 262144

export type CustomThemeSource = 'user' | 'plugin'

export type CustomTheme = {
  slug: string
  name: string
  base: ThemeName
  overrides: Partial<Theme>
  source: CustomThemeSource
}

/** Official 2.1.118 keH */
export function getUserThemesDir(): string {
  return join(getClaudeConfigHomeDir(), 'themes')
}

export function toCustomThemeSetting(slug: string): `custom:${string}` {
  return `${CUSTOM_THEME_PREFIX}${slug}`
}

export function customThemeSlug(setting: string): string | null {
  return setting.startsWith(CUSTOM_THEME_PREFIX)
    ? setting.slice(CUSTOM_THEME_PREFIX.length)
    : null
}

export function isBuiltInThemeName(name: string): name is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(name)
}

/** Official 2.1.118 aqK */
export function slugifyThemeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'theme'
  )
}

function isThemeColorValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Official 2.1.118 va_ */
export function parseCustomThemeJson(
  slug: string,
  raw: string,
  source: CustomThemeSource,
): CustomTheme | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logForDebugging(`[theme] ${slug}.json: invalid JSON`, { level: 'warn' })
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return
  }
  const obj = parsed as Record<string, unknown>
  const base = isBuiltInThemeName(String(obj.base)) ? (obj.base as ThemeName) : 'dark'
  const name = typeof obj.name === 'string' ? obj.name : slug
  const overrides: Partial<Theme> = {}
  if (typeof obj.overrides === 'object' && obj.overrides !== null) {
    const palette = getTheme(base)
    for (const [key, value] of Object.entries(
      obj.overrides as Record<string, unknown>,
    )) {
      if (Object.hasOwn(palette, key) && isThemeColorValue(value)) {
        overrides[key as keyof Theme] = value
      }
    }
  }
  return { slug, name, base, overrides, source }
}

function readThemeFile(
  path: string,
  slug: string,
  source: CustomThemeSource,
): CustomTheme | undefined {
  try {
    if (statSync(path).size > MAX_THEME_BYTES) {
      logForDebugging(`[theme] ${path} exceeds 256KB; skipping`, {
        level: 'warn',
      })
      return
    }
    return parseCustomThemeJson(slug, readFileSync(path, 'utf8'), source)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logForDebugging(`[theme] failed to read ${path}`, { level: 'warn' })
    }
    return
  }
}

/** Official 2.1.118 DC$ */
export function loadThemesFromDir(
  dir: string,
  source: CustomThemeSource,
  slugPrefix = '',
): CustomTheme[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') {
      const single = readThemeFile(
        dir,
        slugPrefix + basename(dir, '.json'),
        source,
      )
      return single ? [single] : []
    }
    if (code !== 'ENOENT') {
      logForDebugging(`[theme] readdir ${dir} failed`, { level: 'warn' })
    }
    return []
  }
  const themes: CustomTheme[] = []
  for (const entry of entries) {
    if (extname(entry) !== '.json') continue
    const theme = readThemeFile(
      join(dir, entry),
      slugPrefix + basename(entry, '.json'),
      source,
    )
    if (theme) themes.push(theme)
  }
  return themes
}

let pluginThemes: CustomTheme[] = []

/** Plugin loader can register `themes/` dirs without this module importing plugins. */
export function registerPluginThemes(themes: CustomTheme[]): void {
  pluginThemes = themes
}

export function getRegisteredPluginThemes(): CustomTheme[] {
  return pluginThemes
}

/** Official 2.1.118 fU8 */
export function loadCustomThemes(): CustomTheme[] {
  const user = loadThemesFromDir(getUserThemesDir(), 'user')
  const all = [...user, ...pluginThemes]
  all.sort((a, b) => a.name.localeCompare(b.name))
  return all
}

/** Official 2.1.118 zU8 */
export async function writeCustomTheme(theme: {
  slug: string
  name: string
  base: ThemeName
  overrides: Partial<Theme>
}): Promise<void> {
  const dir = getUserThemesDir()
  await mkdir(dir, { recursive: true })
  const payload = {
    name: theme.name,
    base: theme.base,
    overrides: theme.overrides,
  }
  await writeFile(
    join(dir, `${theme.slug}.json`),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  )
}

/** Official 2.1.118 sqK */
export function watchUserThemes(onChange: () => void): () => void {
  const dir = getUserThemesDir()
  if (!existsSync(dir)) {
    return () => {}
  }
  try {
    const watcher = watch(dir, { persistent: false }, () => onChange())
    return () => watcher.close()
  } catch (err) {
    logForDebugging(`[theme] watch failed: ${errorMessage(err)}`, {
      level: 'warn',
    })
    return () => {}
  }
}

export function mergeTheme(base: Theme, overrides?: Partial<Theme>): Theme {
  if (!overrides || Object.keys(overrides).length === 0) return base
  return { ...base, ...overrides }
}
