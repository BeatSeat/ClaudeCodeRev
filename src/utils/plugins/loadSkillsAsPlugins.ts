import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { logEvent } from '../../services/analytics/index.js'
import { getCwd } from '../cwd.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'

type SkillsDirPlugin = { name: string; scope: 'user' | 'project'; path: string }

async function listSkillPluginDirs(
  dir: string,
  scope: 'user' | 'project',
): Promise<SkillsDirPlugin[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: SkillsDirPlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory()) continue
    out.push({ name: entry.name, scope, path })
  }
  return out
}

/**
 * Official 2.1.142 skills-as-plugins scan of ~/.claude/skills and
 * ./.claude/skills. Emits `tengu_plugin_skills_dir_loaded`.
 */
export async function loadSkillsAsPlugins(): Promise<{
  plugins: SkillsDirPlugin[]
  projectSuppressedCount: number
  errorCount: number
}> {
  const userDir = join(getClaudeConfigHomeDir(), 'skills')
  const projectDir = join(getCwd(), '.claude', 'skills')
  const [userPlugins, projectPlugins] = await Promise.all([
    listSkillPluginDirs(userDir, 'user'),
    listSkillPluginDirs(projectDir, 'project'),
  ])
  const plugins = [...userPlugins, ...projectPlugins]
  const projectSuppressedCount = 0
  const errorCount = 0
  logEvent('tengu_plugin_skills_dir_loaded', {
    count: plugins.length,
    user_count: userPlugins.length,
    project_count: projectPlugins.length,
    project_suppressed_count: projectSuppressedCount,
    error_count: errorCount,
  })
  if (plugins.length > 0) {
    logForDebugging(`Loaded ${plugins.length} skills-as-plugins`)
  }
  return { plugins, projectSuppressedCount, errorCount }
}
