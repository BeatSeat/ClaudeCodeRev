import { resolve } from 'path'
import { stat } from 'fs/promises'
import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { redactOAuthToken } from './api.js'
import {
  isDesignSyncEnabled,
  needsDesignScopeExpansion,
  requireDesignAccess,
} from './auth.js'
import {
  DESIGN_SYNC_SCOPE_NOTICE,
  DESIGN_SYNC_SCOPE_PROMPT,
  DESIGN_SYNC_TOOL_NAME,
  MAX_DESIGN_PATH_LENGTH,
} from './constants.js'
import {
  dispatchDesignSync,
  isReadOnlyMethod,
  methodSummary,
  missingRequiredFields,
  resolveLocalDir,
  type DesignSyncInput,
} from './dispatch.js'
import { isGlobPath, normalizeDesignPath } from './plan.js'
import { DESIGN_SYNC_PROMPT } from './prompt.js'

const fileSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .min(1)
      .max(MAX_DESIGN_PATH_LENGTH)
      .describe('Path within the project, e.g. components/button/index.html'),
    localPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Path on disk to read file contents from, relative to the localDir approved at finalize_plan. Preferred for anything you have on disk: the tool reads, encodes, and uploads directly so the contents never enter the model context. Mutually exclusive with data.',
      ),
    data: z
      .string()
      .optional()
      .describe(
        'Inline file contents (UTF-8 text, or base64 when encoding is "base64"). For small dynamic content only — anything you have on disk should use localPath instead.',
      ),
    encoding: z
      .enum(['base64'])
      .optional()
      .describe('Set to "base64" for binary inline data'),
    mimeType: z.string().optional(),
  }),
)

const assetSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .min(1)
      .max(255)
      .describe('Short human-readable label ("Primary buttons"), not a path'),
    path: z
      .string()
      .min(1)
      .max(MAX_DESIGN_PATH_LENGTH)
      .describe('Project-relative path to the preview/spec file this card renders'),
    subtitle: z
      .string()
      .max(255)
      .optional()
      .describe('Variants shown ("Primary / secondary / ghost, 3 sizes")'),
    viewport: z
      .strictObject({
        width: z.number().int().positive(),
        height: z.number().int().positive().optional(),
      })
      .optional()
      .describe('Card dimensions in the Design System pane'),
    group: z
      .string()
      .max(64)
      .optional()
      .describe(
        'Free-form section label for the Design System pane (max 64 chars). Use the source design system\'s own categorization if it has one — e.g. Material has Buttons/Cards/Forms/etc., a corporate kit might have Actions/Forms/Navigation. Common foundational labels: "Type", "Colors", "Spacing", "Components", "Brand". The pane groups by the value you send.',
      ),
  }),
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    method: z.enum([
      'list_projects',
      'get_project',
      'list_files',
      'get_file',
      'finalize_plan',
      'write_files',
      'delete_files',
      'register_assets',
      'unregister_assets',
      'create_project',
      'report_validate',
    ]),
    projectId: z
      .string()
      .min(1)
      .optional()
      .describe('Required for all methods except list_projects and create_project'),
    path: z.string().min(1).optional().describe('get_file: file path to read'),
    writes: z
      .array(z.string().min(1).max(MAX_DESIGN_PATH_LENGTH))
      .max(256)
      .optional()
      .describe(
        'finalize_plan: exact paths or glob patterns that will be written. `*` matches within a single segment, `**` matches any depth (e.g. `ui_kits/acme/**/*.html`). Max 3 `*`/`**` wildcards per pattern and max 256 entries — use broader globs to cover more files rather than enumerating paths.',
      ),
    deletes: z
      .array(z.string().min(1).max(MAX_DESIGN_PATH_LENGTH))
      .max(256)
      .optional()
      .describe(
        'finalize_plan: exact paths or glob patterns that will be deleted (same syntax and limits as writes).',
      ),
    planId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'write_files/delete_files/register_assets/unregister_assets: token from a prior finalize_plan call',
      ),
    files: z
      .array(fileSchema())
      .max(256)
      .optional()
      .describe(
        'write_files: file contents to write (max 256 per call — split larger bundles across multiple write_files calls under the same planId).',
      ),
    paths: z
      .array(z.string().min(1).max(MAX_DESIGN_PATH_LENGTH))
      .max(256)
      .optional()
      .describe(
        'delete_files: paths to delete. unregister_assets: paths whose Design System pane card should be removed. Max 256 per call — split larger batches across multiple calls under the same planId.',
      ),
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('create_project: name for the new design-system project'),
    assets: z
      .array(assetSchema())
      .max(256)
      .optional()
      .describe(
        'register_assets: cards to register in the Design System pane. Each path must be in the finalized plan. Run after write_files succeeds. Max 256 per call.',
      ),
    localDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'finalize_plan: directory the bundle was built into. write_files with localPath may only read files inside this directory. Defaults to the current working directory. Resolved to an absolute path and shown in the permission prompt.',
      ),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        bad: z.number().int().nonnegative(),
        thin: z.number().int().nonnegative(),
        variantsIdentical: z.number().int().nonnegative(),
        iterations: z.number().int().nonnegative(),
      })
      .optional()
      .describe(
        'report_validate: aggregate from the final .render-check.json — counts only, no component names or paths.',
      ),
  }),
)

const noticeField = { notice: z.string().optional() }

const outputSchema = lazySchema(() =>
  z.discriminatedUnion('method', [
    z.object({
      method: z.literal('list_projects'),
      ...noticeField,
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          ownerDisplayName: z.string().optional(),
          isOwned: z.boolean().optional(),
          updatedAt: z.string().optional(),
        }),
      ),
    }),
    z.object({
      method: z.literal('get_project'),
      ...noticeField,
      projectId: z.string(),
      name: z.string(),
      type: z.string().optional(),
      ownerDisplayName: z.string().optional(),
      isOwned: z.boolean().optional(),
      canEdit: z.boolean().optional(),
    }),
    z.object({
      method: z.literal('list_files'),
      ...noticeField,
      paths: z.array(z.string()),
    }),
    z.object({
      method: z.literal('get_file'),
      ...noticeField,
      path: z.string(),
      content: z.string(),
      contentType: z.string(),
      isBase64: z.boolean(),
      truncated: z.boolean(),
    }),
    z.object({
      method: z.literal('finalize_plan'),
      ...noticeField,
      planId: z.string(),
      writes: z.array(z.string()),
      deletes: z.array(z.string()),
    }),
    z.object({
      method: z.literal('write_files'),
      ...noticeField,
      written: z.number(),
    }),
    z.object({
      method: z.literal('delete_files'),
      ...noticeField,
      deleted: z.number(),
    }),
    z.object({
      method: z.literal('register_assets'),
      ...noticeField,
      registered: z.number(),
    }),
    z.object({
      method: z.literal('unregister_assets'),
      ...noticeField,
      unregistered: z.number(),
    }),
    z.object({
      method: z.literal('create_project'),
      ...noticeField,
      projectId: z.string(),
      name: z.string(),
    }),
    z.object({
      method: z.literal('report_validate'),
      ...noticeField,
    }),
  ]),
)

type InputSchema = ReturnType<typeof inputSchema>
type OutputSchema = ReturnType<typeof outputSchema>
export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

function summarizePaths(paths: string[] | undefined): string {
  const list = paths ?? []
  if (list.length <= 50) return list.join(', ')
  return `${list.length} paths (too many to list here; the user's permission prompt shows the full list)`
}

export const DesignSyncTool = buildTool({
  name: DESIGN_SYNC_TOOL_NAME,
  searchHint: 'sync local design system components to a claude.ai/design project',
  shouldDefer: true,
  maxResultSizeChars: 300000,
  isEnabled() {
    return isDesignSyncEnabled()
  },
  async description() {
    return DESIGN_SYNC_PROMPT
  },
  async prompt() {
    return DESIGN_SYNC_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return isReadOnlyMethod(input.method)
  },
  isDestructive(input: Input) {
    return (
      input.method === 'write_files' ||
      input.method === 'delete_files' ||
      input.method === 'unregister_assets'
    )
  },
  userFacingName(input?: Input) {
    return `Design: ${methodSummary(input)}`
  },
  getToolUseSummary(input?: Partial<Input>) {
    return input?.method ? methodSummary(input) : null
  },
  toAutoClassifierInput(input: Input) {
    if (input.method === 'finalize_plan') {
      return `project ${input.projectId ?? '?'} from ${resolve(getCwd(), input.localDir ?? '.')}: write ${summarizePaths(input.writes)}; delete ${summarizePaths(input.deletes)}`
    }
    if (input.method === 'create_project') {
      return `create project "${input.name ?? '?'}"`
    }
    return input.method
  },
  renderToolUseMessage(input: Partial<Input>) {
    return methodSummary(input)
  },
  async validateInput(input: Input) {
    const missing = missingRequiredFields(input as DesignSyncInput)
    if (missing.length > 0) {
      return {
        result: false as const,
        message: `${input.method} requires: ${missing.join(', ')}.`,
        errorCode: 1,
      }
    }
    if (
      input.method === 'finalize_plan' &&
      (input.writes?.length ?? 0) === 0 &&
      (input.deletes?.length ?? 0) === 0
    ) {
      return {
        result: false as const,
        message: 'finalize_plan needs at least one write or delete path.',
        errorCode: 1,
      }
    }
    if (input.method === 'write_files') {
      for (const file of input.files ?? []) {
        const hasData = file.data !== undefined
        const hasLocal = file.localPath !== undefined
        if (hasData === hasLocal) {
          return {
            result: false as const,
            message: `Each file needs exactly one of "data" or "localPath" (offending path: ${file.path}).`,
            errorCode: 1,
          }
        }
        if (hasLocal && file.encoding !== undefined) {
          return {
            result: false as const,
            message: `"encoding" only applies to inline "data"; localPath files are encoded automatically (offending path: ${file.path}).`,
            errorCode: 1,
          }
        }
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input) {
    const scopePrompt = needsDesignScopeExpansion()
      ? DESIGN_SYNC_SCOPE_PROMPT
      : null
    if (
      scopePrompt &&
      input.method !== 'finalize_plan' &&
      input.method !== 'create_project'
    ) {
      return {
        behavior: 'ask' as const,
        message: scopePrompt,
        updatedInput: input,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason:
            'scope expansion — approving persists user:design:write to the OAuth credential store',
          classifierApprovable: false,
        },
      }
    }
    if (input.method === 'finalize_plan') {
      const writes = (input.writes ?? []).map(normalizeDesignPath)
      const deletes = (input.deletes ?? []).map(normalizeDesignPath)
      let localDir: string
      try {
        localDir = await resolveLocalDir(input.localDir)
      } catch (err) {
        return {
          behavior: 'deny' as const,
          message: `localDir does not exist or is not accessible: ${input.localDir ?? getCwd()} (${errorMessage(err)})`,
          decisionReason: {
            type: 'safetyCheck' as const,
            reason: 'localDir not found',
            classifierApprovable: false,
          },
        }
      }
      const writeGlobs = writes.filter(isGlobPath)
      const writeLiterals = writes.filter(p => !isGlobPath(p))
      const deleteGlobs = deletes.filter(isGlobPath)
      const deleteLiterals = deletes.filter(p => !isGlobPath(p))
      const exists = await Promise.all(
        writeLiterals.map(async p => {
          try {
            await stat(resolve(localDir, p))
            return true
          } catch {
            return false
          }
        }),
      )
      const missing = writeLiterals.filter((_, i) => !exists[i])
      const missingNote =
        writeLiterals.length - missing.length > 0 && missing.length > 0
          ? `⚠ ${missing.length} of ${writeLiterals.length} literal write ${plural(writeLiterals.length, 'path')} not found under localDir — expected if they use a different localPath or inline data, otherwise check for a typo: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `, … and ${missing.length - 5} more` : ''}`
          : null
      return {
        behavior: 'ask' as const,
        message: [
          scopePrompt,
          `Project ${input.projectId ?? '?'}`,
          `Read from ${localDir}`,
          writeLiterals.length > 0
            ? `Write ${writeLiterals.length}: ${writeLiterals.join(', ')}`
            : null,
          writeGlobs.length > 0
            ? `Write (glob) ${writeGlobs.length}: ${writeGlobs.join(', ')}`
            : null,
          missingNote,
          deleteLiterals.length > 0
            ? `Delete ${deleteLiterals.length}: ${deleteLiterals.join(', ')}`
            : null,
          deleteGlobs.length > 0
            ? `Delete (glob) ${deleteGlobs.length}: ${deleteGlobs.join(', ')}`
            : null,
        ]
          .filter(line => line !== null)
          .join('\n'),
        updatedInput: { ...input, localDir },
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: scopePrompt
            ? 'scope expansion — approving persists user:design:write to the OAuth credential store'
            : 'finalize_plan is the path-review consent boundary — the human reviews the path set, not the classifier, and no always-allow rule may skip it',
          classifierApprovable: false,
        },
      }
    }
    if (input.method === 'create_project') {
      return {
        behavior: 'ask' as const,
        message: [
          scopePrompt,
          `Create design-system project "${input.name ?? '?'}" on claude.ai/design. The new project will be visible to your whole org (server default — you can change this from the Share menu after creation).`,
        ]
          .filter(line => line !== null)
          .join('\n'),
        updatedInput: input,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: scopePrompt
            ? 'scope expansion — approving persists user:design:write to the OAuth credential store'
            : 'create_project creates an org-visible resource — always prompt, no always-allow rule may skip it',
          classifierApprovable: false,
        },
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input, context) {
    const signal = context.abortController.signal
    if (input.method === 'report_validate') {
      return { data: { method: 'report_validate' as const } }
    }
    let accessToken = ''
    try {
      const auth = await requireDesignAccess()
      accessToken = auth.accessToken
      const result = await dispatchDesignSync(
        input as DesignSyncInput,
        accessToken,
        signal,
      )
      return {
        data: auth.expanded
          ? { ...result, notice: DESIGN_SYNC_SCOPE_NOTICE }
          : result,
      }
    } catch (err) {
      if (signal.aborted) throw new AbortError()
      throw new Error(redactOAuthToken(errorMessage(err), accessToken))
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: jsonStringify(output),
    }
  },
}) as unknown as Tool<InputSchema, Output>
