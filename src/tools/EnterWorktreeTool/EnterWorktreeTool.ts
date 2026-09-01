import { sep } from 'path'
import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd, hasCwdOverride, setCwd as applyPinnedCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setSandboxAgentCwd } from '../../utils/sandbox/sandbox-adapter.js'
import { setCwd } from '../../utils/Shell.js'
import {
  readAgentMetadata,
  saveWorktreeState,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  enterExistingWorktreeForSession,
  getCurrentWorktreeSession,
  resolveExistingWorktree,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      name: z
        .string()
        .superRefine((s, ctx) => {
          try {
            validateWorktreeSlug(s)
          } catch (e) {
            ctx.addIssue({ code: 'custom', message: (e as Error).message })
          }
        })
        .optional()
        .describe(
          'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Path to an existing worktree of the current repository to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo. Mutually exclusive with `name`.',
        ),
    })
    .refine(input => !(input.name && input.path), {
      message: 'Provide at most one of `name` or `path`, not both.',
    }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName(input) {
    return input?.path ? 'Entering worktree' : 'Creating worktree'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.path ?? input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async validateInput(input) {
    if (hasCwdOverride()) {
      if (input.path) return { result: true }
      const cwd = getCwd()
      const gitRoot = findCanonicalGitRoot(cwd) ?? findGitRoot(cwd)
      return {
        result: false,
        message:
          `EnterWorktree cannot create a worktree from a subagent with a cwd override (isolation: "worktree" or explicit cwd) — it would mutate the parent session's process-wide working directory. ` +
          (gitRoot != null && cwd !== gitRoot && cwd.startsWith(gitRoot + sep)
            ? 'To switch this agent into an existing worktree managed by Claude Code (under .claude/worktrees/ of this repository), call EnterWorktree with `path`. To work in any other directory, spawn an Agent with `cwd` set to it.'
            : 'To work in a different directory (including a worktree), spawn an Agent with `cwd` set to it.'),
        errorCode: 1,
      }
    }
    if (getCurrentWorktreeSession() && !input.path) {
      return {
        result: false,
        message:
          'Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input, context) {
    // Official 2.1.157 `kGH` arm — pinned-cwd subagent switches this agent
    // only (no parent chdir).
    if (hasCwdOverride()) {
      if (!input.path) {
        throw new Error(
          'EnterWorktree from a session with a pinned working directory requires `path`.',
        )
      }
      const resolved = await resolveExistingWorktree(input.path, {
        requireManagedLocation: true,
        requireCwdInsideRepo: true,
      })
      applyPinnedCwd(resolved.worktreePath)
      setSandboxAgentCwd(
        resolved.worktreePath,
        context.agentId ?? getSessionId(),
      )
      if (context.agentId) {
        try {
          const meta = await readAgentMetadata(context.agentId)
          if (meta) {
            await writeAgentMetadata(context.agentId, {
              ...meta,
              cwd: resolved.worktreePath,
            })
          }
        } catch (error) {
          logForDebugging(
            `Failed to update agent metadata cwd after worktree switch: ${errorMessage(error)}`,
          )
        }
      }
      logEvent('tengu_worktree_entered_existing', {
        mid_session: true,
        cwd_override: true,
      })
      const branchInfo = resolved.worktreeBranch
        ? ` on branch ${resolved.worktreeBranch}`
        : ''
      return {
        data: {
          worktreePath: resolved.worktreePath,
          worktreeBranch: resolved.worktreeBranch,
          message: `Entered worktree at ${resolved.worktreePath}${branchInfo}. This agent's working directory and write access now point at the worktree; the previous directory was left untouched.`,
        },
        contextLayers: [
          { kind: 'working_directory', directory: resolved.worktreePath },
        ],
      }
    }

    if (getCurrentWorktreeSession() && !input.path) {
      throw new Error('Already in a worktree session')
    }

    let worktreeSession
    if (input.path) {
      worktreeSession = await enterExistingWorktreeForSession(
        getSessionId(),
        input.path,
      )
    } else {
      // Resolve to main repo root so worktree creation works from within a worktree
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (mainRepoRoot && mainRepoRoot !== getCwd()) {
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }
      const slug = input.name ?? getPlanSlug()
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        undefined,
        { fromHead: true },
      )
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear cached system prompt sections so env_info_simple recomputes with worktree context
    clearSystemPromptSections()
    // Clear memoized caches that depend on CWD
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent(
      input.path ? 'tengu_worktree_entered_existing' : 'tengu_worktree_created',
      { mid_session: true },
    )

    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''
    const verb = input.path ? 'Entered' : 'Created'

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `${verb} worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
