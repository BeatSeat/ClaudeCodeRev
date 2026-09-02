export const DESIGN_SYNC_TOOL_NAME = 'DesignSync'

/** Official 2.1.160 `Cc5`. */
export const OMELETTE_SERVICE =
  'anthropic.omelette.api.v1alpha.OmeletteService'
/** Official 2.1.160 `vc6`. */
export const PROJECT_TYPE_DESIGN_SYSTEM = 'PROJECT_TYPE_DESIGN_SYSTEM'
/** Official 2.1.160 `pc5`. */
export const DESIGN_READ_SCOPE = 'user:design:read'
/** Official 2.1.160 `Uc5`. */
export const DESIGN_WRITE_SCOPE = 'user:design:write'
/** Official 2.1.160 `tAH` header. */
export const DESIGN_SYNC_CLIENT = 'claude-cli-design-sync'
/** Official 2.1.160 `yJ4`. */
export const MAX_WRITE_FILE_BYTES = 5_242_880
/** Official 2.1.160 `tRH`. */
export const MAX_DESIGN_PATH_LENGTH = 256
/** Official 2.1.160 `WJ4`. */
export const MAX_GLOB_WILDCARDS = 3
/** Official 2.1.160 `mc5`. */
export const PLAN_ID_RE = /^plan_[a-z0-9]{1,16}_[a-f0-9]{12}$/

export const READ_ONLY_METHODS = [
  'list_projects',
  'get_project',
  'list_files',
  'get_file',
  'report_validate',
] as const

/** Official 2.1.160 `sc5`. */
export const TEXT_MIME_EXTENSIONS = new Set([
  'html',
  'css',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'json',
  'svg',
  'xml',
  'md',
  'txt',
  'csv',
  'yaml',
  'yml',
  'toml',
])

/** Official 2.1.160 `dc5`. */
export const METHOD_REQUIRED_FIELDS: Record<
  string,
  { present: string[]; nonEmpty: string[] }
> = {
  list_projects: { present: [], nonEmpty: [] },
  get_project: { present: ['projectId'], nonEmpty: [] },
  list_files: { present: ['projectId'], nonEmpty: [] },
  get_file: { present: ['projectId', 'path'], nonEmpty: [] },
  finalize_plan: { present: ['projectId', 'writes', 'deletes'], nonEmpty: [] },
  write_files: { present: ['projectId', 'planId'], nonEmpty: ['files'] },
  delete_files: { present: ['projectId', 'planId'], nonEmpty: ['paths'] },
  register_assets: { present: ['projectId', 'planId'], nonEmpty: ['assets'] },
  unregister_assets: { present: ['projectId', 'planId'], nonEmpty: ['paths'] },
  create_project: { present: ['name'], nonEmpty: [] },
  report_validate: { present: ['counts'], nonEmpty: [] },
}

/** Official 2.1.160 `rc5`. */
export const DESIGN_SYNC_SCOPE_NOTICE =
  "Upgraded your claude.ai login to include design-system access (user:design:read, user:design:write). This lets /design-sync read and write your org's design-system projects on claude.ai/design."

/** Official 2.1.160 `checkPermissions` scope-expansion copy. */
export const DESIGN_SYNC_SCOPE_PROMPT =
  "DesignSync needs design-system access added to your claude.ai login (user:design:read, user:design:write). Approving refreshes your token with these scopes and persists them — you'll be able to read and write your org's design-system projects on claude.ai/design in this and future sessions."
