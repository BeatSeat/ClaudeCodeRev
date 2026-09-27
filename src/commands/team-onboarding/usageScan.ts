import { readdir, readFile, stat } from 'fs/promises'
import { basename, extname, join } from 'path'
import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG } from '../../constants/xml.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { gitExe, normalizeGitRemoteUrl } from '../../utils/git.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const MAX_SESSION_FILE_BYTES = 52_428_800
const FIRST_MESSAGE_CHARS = 200
const MAX_SESSION_DESCRIPTORS = 60

const SLASH_COMMAND_RE = /<command-name>\/([\w:-]+)<\/command-name>/g
const MCP_TOOL_RE = /"name":"mcp__([^"]+?)__([^"]+)"/g
const CUSTOM_TITLE_RE = /"customTitle":"([^"]+)"/
const PR_NUMBER_RE = /"prNumber":(\d+)/
const FIRST_USER_MESSAGE_RE = /"role":"user"[^}]*"content":"([^"]+)"/

const COMMAND_NAME_CONTENT = `"content":"<${COMMAND_NAME_TAG}>/`
const COMMAND_MESSAGE_CONTENT = `"content":"<${COMMAND_MESSAGE_TAG}>`
const TOOL_USE_TYPE = '"type":"tool_use"'
const CUSTOM_TITLE_TYPE = '"type":"custom-title"'
const PR_LINK_TYPE = '"type":"pr-link"'
const USER_ROLE = '"role":"user"'

type SessionDescriptor = {
  title?: string
  prNumbers: number[]
  firstMessage?: string
}

type ScanTotals = {
  slashCommandCounts: Map<string, number>
  mcpServerCounts: Map<string, number>
  sessionDescriptors: SessionDescriptor[]
  sessionFileCount: number
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function descriptorScore(d: SessionDescriptor): number {
  return (d.title ? 2 : 0) + (d.prNumbers.length > 0 ? 1 : 0)
}

/** Official 2.1.94 ncK: scan local transcripts in the current project dir. */
async function scanProjectTranscripts(
  projectDir: string,
  windowDays: number,
): Promise<ScanTotals> {
  const totals: ScanTotals = {
    slashCommandCounts: new Map(),
    mcpServerCounts: new Map(),
    sessionDescriptors: [],
    sessionFileCount: 0,
  }
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch (err) {
    if (isENOENT(err)) return totals
    throw err
  }

  for (const name of names) {
    if (extname(name) !== '.jsonl') continue
    const path = join(projectDir, name)
    let st
    try {
      st = await stat(path)
    } catch (err) {
      if (isENOENT(err)) continue
      throw err
    }
    if (!st.isFile()) continue
    if (st.mtimeMs < cutoff || st.size > MAX_SESSION_FILE_BYTES) continue

    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch (err) {
      if (isENOENT(err)) continue
      throw err
    }

    totals.sessionFileCount++
    const descriptor: SessionDescriptor = { prNumbers: [] }
    for (const line of text.split('\n')) {
      if (line.length < 10) continue
      if (
        line.includes(COMMAND_NAME_CONTENT) ||
        line.includes(COMMAND_MESSAGE_CONTENT)
      ) {
        for (const match of line.matchAll(SLASH_COMMAND_RE)) {
          const cmd = match[1]
          if (cmd) bump(totals.slashCommandCounts, cmd)
        }
      }
      if (line.includes(TOOL_USE_TYPE) && line.includes('"name":"mcp__')) {
        for (const match of line.matchAll(MCP_TOOL_RE)) {
          const server = match[1]
          if (server) bump(totals.mcpServerCounts, server)
        }
      }
      if (line.includes(CUSTOM_TITLE_TYPE)) {
        const title = CUSTOM_TITLE_RE.exec(line)?.[1]
        if (title) descriptor.title = title
      }
      if (line.includes(PR_LINK_TYPE)) {
        const raw = PR_NUMBER_RE.exec(line)?.[1]
        const pr = raw ? Number(raw) : NaN
        if (Number.isFinite(pr) && !descriptor.prNumbers.includes(pr)) {
          descriptor.prNumbers.push(pr)
        }
      }
      if (
        !descriptor.firstMessage &&
        line.includes(USER_ROLE) &&
        !line.includes(COMMAND_NAME_CONTENT) &&
        !line.includes('"content":[')
      ) {
        const raw = FIRST_USER_MESSAGE_RE.exec(line)?.[1]
        if (raw) {
          const message = raw.replace(/\\n/g, ' ').replace(/\\"/g, '"')
          if (message.length > 3 && !message.startsWith('<')) {
            descriptor.firstMessage = message.slice(0, FIRST_MESSAGE_CHARS)
          }
        }
      }
    }
    if (
      descriptor.title ||
      descriptor.prNumbers.length > 0 ||
      descriptor.firstMessage
    ) {
      totals.sessionDescriptors.push(descriptor)
    }
  }

  if (totals.sessionDescriptors.length > MAX_SESSION_DESCRIPTORS) {
    totals.sessionDescriptors.sort(
      (a, b) => descriptorScore(b) - descriptorScore(a),
    )
    totals.sessionDescriptors = totals.sessionDescriptors.slice(
      0,
      MAX_SESSION_DESCRIPTORS,
    )
  }
  return totals
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

async function readProjectMcpServers(
  cwd: string,
): Promise<Record<string, { url?: string }>> {
  try {
    const raw = await readFile(join(cwd, '.mcp.json'), 'utf8')
    const parsed = safeParseJSON(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'mcpServers' in parsed &&
      parsed.mcpServers &&
      typeof parsed.mcpServers === 'object'
    ) {
      return parsed.mcpServers as Record<string, { url?: string }>
    }
  } catch (err) {
    if (!isENOENT(err)) {
      logError(
        `team-onboarding: failed to read .mcp.json: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return {}
}

export type TeamOnboardingUsage = {
  usageData: string
  sessionCount: number
  slashCommandCount: number
  mcpServerCount: number
}

/** Official 2.1.94 hgY. */
export async function collectTeamOnboardingUsage(
  windowDays: number,
): Promise<TeamOnboardingUsage> {
  const cwd = getCwd()
  const totals = await scanProjectTranscripts(getProjectDir(cwd), windowDays)
  const slashCommands = [...totals.slashCommandCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name: `/${name}`, count }))
  const mcpConfig = await readProjectMcpServers(cwd)
  const mcpServers = [...totals.mcpServerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, callCount]) => {
      const server = mcpConfig[name]
      return {
        name,
        callCount,
        urlOrigin:
          typeof server?.url === 'string' ? originOf(server.url) : undefined,
      }
    })
  const generatedBy = (
    await execFileNoThrow(gitExe(), ['config', 'user.name'])
  ).stdout.trim()
  const remote = (
    await execFileNoThrow(gitExe(), ['remote', 'get-url', 'origin'])
  ).stdout.trim()

  return {
    usageData: jsonStringify(
      {
        generatedBy: generatedBy || undefined,
        currentRepo: normalizeGitRemoteUrl(remote) ?? basename(cwd),
        windowDays,
        sessionCount: totals.sessionFileCount,
        slashCommands,
        mcpServers,
        sessionDescriptors: totals.sessionDescriptors,
      },
      null,
      2,
    ),
    sessionCount: totals.sessionFileCount,
    slashCommandCount: totals.slashCommandCounts.size,
    mcpServerCount: totals.mcpServerCounts.size,
  }
}
