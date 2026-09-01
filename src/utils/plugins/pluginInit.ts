/**
 * Official 2.1.141 `zp5` / `claude plugin init` scaffold.
 */
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { execa } from 'execa'
import figures from 'figures'
import { getCwd } from '../cwd.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import {
  getBlockedMarketplaces,
  getStrictKnownMarketplaces,
} from './marketplaceHelpers.js'
import { PluginManifestSchema } from './schemas.js'
import { validatePluginContents } from './validatePlugin.js'

const PLUGIN_SCHEMA_URL =
  'https://anthropic.com/claude-code/plugin.schema.json'
const INIT_COMPONENTS = ['agents', 'hooks', 'mcp', 'lsp'] as const
const SKILLS_DIR_SOURCE = 'skills-dir'

type InitComponent = (typeof INIT_COMPONENTS)[number]

type ScaffoldFile = {
  relPath: string
  contents: string
  mode?: number
}

export function validatePluginName(name: string): string | null {
  const parsed = PluginManifestSchema().shape.name.safeParse(name)
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? null
  }
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name === '.'
  ) {
    return 'Plugin name cannot contain path separators (/ or \\), ".." sequences, or be "."'
  }
  return null
}

/** Bundle `f3$` — skills-dir must not be blocked; if an allowlist exists it must include skills-dir. */
export function isSkillsDirPluginInitAllowed(): boolean {
  const blocked = getBlockedMarketplaces()
  if (blocked?.some(s => (s as { source?: string }).source === SKILLS_DIR_SOURCE))
    return false
  const allow = getStrictKnownMarketplaces()
  return (
    allow === null ||
    allow.some(s => (s as { source?: string }).source === SKILLS_DIR_SOURCE)
  )
}

export function skillsDirPolicyBlockedMessage(skillsDir: string): string {
  return `Plugins from ${skillsDir}/ are blocked by your organization's managed settings (strictKnownMarketplaces or blockedMarketplaces). Ask your administrator to add {"source":"skills-dir"} to strictKnownMarketplaces, or remove it from blockedMarketplaces.`
}

function skillMarkdown(name: string): string {
  return `---
name: ${name}
description: TODO — describe WHEN Claude should use this. Include trigger phrases users
  might say ("do X", "set up Y", "review Z"). Be specific; this string is what Claude
  matches the user's request against.
---

# ${name}

TODO: what this skill does, and the steps Claude should take.
`
}

function exampleAgentMarkdown(): string {
  return `---
name: example
description: TODO — when should Claude delegate to this subagent?
tools:
  - Read
  - Grep
---

TODO: system prompt for the subagent.
`
}

function hooksJson(): string {
  return (
    jsonStringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'bun ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/on-session-start.ts',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  )
}

function sessionStartHandler(): string {
  return `#!/usr/bin/env bun
// SessionStart hook handler. Reads the event from stdin, writes a JSON result
// to stdout. Swap "bun" for "node" or "python3" in hooks/hooks.json if your
// users' environment lacks bun.
const input = await new Response(Bun.stdin.stream()).text()
const event = JSON.parse(input)
process.stdout.write(JSON.stringify({}))
`
}

function mcpJson(): string {
  return (
    jsonStringify(
      {
        mcpServers: {
          example: { type: 'http', url: 'https://example.com/mcp' },
        },
      },
      null,
      2,
    ) + '\n'
  )
}

function lspJson(): string {
  return (
    jsonStringify(
      {
        example: {
          command: 'example-language-server',
          args: ['--stdio'],
          extensionToLanguage: { '.example': 'example' },
        },
      },
      null,
      2,
    ) + '\n'
  )
}

export function scaffoldPluginFiles(opts: {
  name: string
  description?: string
  author?: { name: string; email?: string }
  with?: InitComponent[]
}): ScaffoldFile[] {
  const extras = opts.with ?? []
  const manifest: Record<string, unknown> = {
    $schema: PLUGIN_SCHEMA_URL,
    name: opts.name,
    version: '0.1.0',
    description: opts.description ?? 'TODO: describe what this plugin provides',
  }
  if (opts.author) manifest.author = opts.author
  const files: ScaffoldFile[] = [
    {
      relPath: join('.claude-plugin', 'plugin.json'),
      contents: jsonStringify(manifest, null, 2) + '\n',
    },
    {
      relPath: join('skills', opts.name, 'SKILL.md'),
      contents: skillMarkdown(opts.name),
    },
  ]
  if (extras.includes('agents')) {
    files.push({ relPath: join('agents', 'example.md'), contents: exampleAgentMarkdown() })
  }
  if (extras.includes('hooks')) {
    files.push({ relPath: join('hooks', 'hooks.json'), contents: hooksJson() })
    files.push({
      relPath: join('hooks-handlers', 'on-session-start.ts'),
      contents: sessionStartHandler(),
      mode: 0o755,
    })
  }
  if (extras.includes('mcp')) {
    files.push({ relPath: '.mcp.json', contents: mcpJson() })
  }
  if (extras.includes('lsp')) {
    files.push({ relPath: '.lsp.json', contents: lspJson() })
  }
  return files
}

async function writeScaffold(
  pluginDir: string,
  files: ScaffoldFile[],
  force: boolean,
): Promise<{ ok: true; skipped: string[] } | { ok: false; error: string }> {
  const root = resolve(pluginDir)
  if (!force) {
    try {
      await mkdir(join(root, '.claude-plugin'))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        return {
          ok: false,
          error: `${join(root, '.claude-plugin')} already exists. Use --force to overwrite.`,
        }
      }
      if (code !== 'ENOENT') throw err
    }
  }
  const skipped: string[] = []
  for (const file of files) {
    const dest = resolve(root, file.relPath)
    const rel = relative(root, dest)
    if (rel.startsWith(`..${sep}`) || rel === '..') {
      return { ok: false, error: `Refusing to write outside ${root}: ${file.relPath}` }
    }
    await mkdir(dirname(dest), { recursive: true })
    if (force) {
      await writeFile(dest, file.contents, { mode: file.mode })
    } else {
      try {
        await writeFile(dest, file.contents, { flag: 'wx', mode: file.mode })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        skipped.push(file.relPath)
      }
    }
  }
  return { ok: true, skipped }
}

async function gitConfigValue(key: string): Promise<string | undefined> {
  const result = await execa(`git config --get ${key}`, {
    shell: true,
    reject: false,
    cwd: getCwd(),
  })
  return result.exitCode === 0 && result.stdout
    ? result.stdout.trim()
    : undefined
}

export async function pluginInitHandler(
  name: string,
  options: {
    with?: string[]
    description?: string
    author?: string
    authorEmail?: string
    force?: boolean
  },
): Promise<void> {
  const lines: string[] = []
  const exit = (code: number): never => {
    // biome-ignore lint/suspicious/noConsole:: CLI
    console.log(lines.join('\n'))
    process.exit(code)
  }

  const nameErr = validatePluginName(name)
  if (nameErr) {
    const { logEvent } = await import('../../services/analytics/index.js')
    logEvent('cli_plugin_init', { reason: 'invalid_name' })
    lines.push(`${figures.cross} Invalid plugin name "${name}": ${nameErr}`)
    exit(1)
  }

  const extras: InitComponent[] = []
  for (const item of options.with ?? []) {
    if ((INIT_COMPONENTS as readonly string[]).includes(item)) {
      extras.push(item as InitComponent)
    } else {
      const { logEvent } = await import('../../services/analytics/index.js')
      logEvent('cli_plugin_init', { reason: 'invalid_component' })
      lines.push(
        `${figures.cross} Unknown --with component "${item}". Valid: ${INIT_COMPONENTS.join(', ')}`,
      )
      exit(1)
    }
  }

  const skillsDir = join(getClaudeConfigHomeDir(), 'skills')
  if (!isSkillsDirPluginInitAllowed()) {
    const { logEvent } = await import('../../services/analytics/index.js')
    logEvent('cli_plugin_init', { reason: 'policy_blocked' })
    lines.push(`${figures.cross} ${skillsDirPolicyBlockedMessage(skillsDir)}`)
    exit(1)
  }

  const pluginDir = join(skillsDir, name)
  if (relative(skillsDir, resolve(pluginDir)).startsWith('..')) {
    const { logEvent } = await import('../../services/analytics/index.js')
    logEvent('cli_plugin_init', { reason: 'invalid_name' })
    lines.push(
      `${figures.cross} Plugin name "${name}" would write outside ${skillsDir}`,
    )
    exit(1)
  }

  const authorName = options.author ?? (await gitConfigValue('user.name'))
  const authorEmail = options.authorEmail ?? (await gitConfigValue('user.email'))
  if (!authorName && options.authorEmail) {
    lines.push(
      `${figures.warning} --author-email was ignored because no author name was found. Pass --author or set git config user.name.`,
    )
  }
  const author = authorName
    ? authorEmail
      ? { name: authorName, email: authorEmail }
      : { name: authorName }
    : undefined

  const files = scaffoldPluginFiles({
    name,
    description: options.description,
    author,
    with: extras,
  })

  const { logEvent } = await import('../../services/analytics/index.js')
  let skipped: string[]
  try {
    const written = await writeScaffold(pluginDir, files, options.force === true)
    if (!written.ok) {
      logEvent('cli_plugin_init', { reason: 'target_exists' })
      lines.push(`${figures.cross} ${written.error}`)
      exit(1)
    }
    skipped = written.skipped
  } catch (err) {
    logError(err)
    logEvent('cli_plugin_init', { reason: 'write_failed' })
    lines.push(`${figures.cross} Failed to write scaffold: ${errorMessage(err)}`)
    exit(1)
  }

  for (const rel of skipped) {
    lines.push(`  kept existing ${rel} (use --force to overwrite)`)
  }

  const validation = await validatePluginContents(pluginDir)
  const failed = validation.filter(r => !r.success)
  for (const r of validation) {
    for (const e of r.errors) {
      lines.push(`${figures.cross} ${e.path}: ${e.message}`)
    }
    for (const w of r.warnings) {
      lines.push(`${figures.warning} ${w.path}: ${w.message}`)
    }
  }
  if (failed.length > 0) {
    logEvent('cli_plugin_init', { reason: 'self_validate_failed' })
    exit(1)
  }

  logEvent('cli_plugin_init', {})
  lines.push(
    `${figures.tick} Created plugin "${name}" at ${pluginDir}`,
    `  It will auto-load next session as ${name}@${SKILLS_DIR_SOURCE}. Run /reload-plugins to load it now.`,
    `  Disable: claude plugin disable ${name}@${SKILLS_DIR_SOURCE}. Remove: delete the directory.`,
  )
  exit(0)
}
