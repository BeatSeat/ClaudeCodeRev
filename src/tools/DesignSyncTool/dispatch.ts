import { constants as fsConstants } from 'fs'
import { open, realpath } from 'fs/promises'
import { extname, resolve, sep } from 'path'
import { count } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { AbortError } from '../../utils/errors.js'
import { plural } from '../../utils/stringUtils.js'
import {
  createProject,
  deleteAsset,
  deleteFiles,
  getFile,
  getProject,
  listFiles,
  listOrgProjects,
  recordAsset,
  writeFiles,
} from './api.js'
import {
  MAX_WRITE_FILE_BYTES,
  METHOD_REQUIRED_FIELDS,
  PROJECT_TYPE_DESIGN_SYSTEM,
  TEXT_MIME_EXTENSIONS,
} from './constants.js'
import {
  getPlan,
  isGlobPath,
  isReservedDesignPath,
  normalizeDesignPath,
  pathMatchesPlan,
  registerPlan,
} from './plan.js'

export type DesignSyncInput = {
  method: string
  projectId?: string
  path?: string
  writes?: string[]
  deletes?: string[]
  planId?: string
  files?: Array<{
    path: string
    localPath?: string
    data?: string
    encoding?: 'base64'
    mimeType?: string
  }>
  paths?: string[]
  name?: string
  assets?: Array<{
    name: string
    path: string
    subtitle?: string
    viewport?: { width: number; height?: number }
    group?: string
  }>
  localDir?: string
  counts?: {
    total: number
    bad: number
    thin: number
    variantsIdentical: number
    iterations: number
  }
}

/** Official 2.1.160 `F0`. */
export function requireField<T>(
  value: T | undefined,
  field: string,
  method: string,
): T {
  if (value === undefined) {
    throw new Error(`${method} requires "${field}"`)
  }
  return value
}

/** Official 2.1.160 `hJ4`. */
export async function resolveLocalDir(localDir?: string): Promise<string> {
  return realpath(resolve(getCwd(), localDir ?? '.'))
}

/** Official 2.1.160 `cc5`. */
export function missingRequiredFields(input: DesignSyncInput): string[] {
  const spec = METHOD_REQUIRED_FIELDS[input.method]
  if (!spec) return []
  const present = spec.present.filter(
    field => input[field as keyof DesignSyncInput] === undefined,
  )
  const nonEmpty = spec.nonEmpty.filter(field => {
    const value = input[field as keyof DesignSyncInput]
    return value === undefined || (Array.isArray(value) && value.length === 0)
  })
  return [...present, ...nonEmpty]
}

/** Official 2.1.160 `nc5`. */
export function isReadOnlyMethod(method: string): boolean {
  return (
    method === 'list_projects' ||
    method === 'get_project' ||
    method === 'list_files' ||
    method === 'get_file' ||
    method === 'report_validate'
  )
}

/** Official 2.1.160 `Ec6`. */
export function methodSummary(input: Partial<DesignSyncInput> | undefined): string {
  switch (input?.method) {
    case 'list_projects':
      return 'List design-system projects'
    case 'get_project':
      return 'Read project metadata'
    case 'list_files':
      return 'List project files'
    case 'get_file':
      return input.path ? `Read ${input.path}` : 'Read file'
    case 'finalize_plan':
      return `Finalize plan (${input.writes?.length ?? 0} writes, ${input.deletes?.length ?? 0} deletes)`
    case 'write_files': {
      const n = input.files?.length ?? 0
      const fromDisk = count(
        input.files ?? [],
        file => file.localPath !== undefined,
      )
      const suffix =
        fromDisk > 0 && fromDisk < n
          ? ` (${fromDisk} from disk, ${n - fromDisk} inline)`
          : fromDisk === n && n > 0
            ? ' from disk'
            : ''
      return `Write ${n} ${plural(n, 'file')}${suffix}`
    }
    case 'delete_files':
      return `Delete ${input.paths?.length ?? 0} ${plural(input.paths?.length ?? 0, 'file')}`
    case 'register_assets':
      return `Register ${input.assets?.length ?? 0} ${plural(input.assets?.length ?? 0, 'asset card')}`
    case 'unregister_assets':
      return `Unregister ${input.paths?.length ?? 0} ${plural(input.paths?.length ?? 0, 'asset card')}`
    case 'create_project':
      return input.name
        ? `Create project "${input.name}"`
        : 'Create design-system project'
    case 'report_validate':
      return 'Report validate metrics'
    default:
      return 'Design sync'
  }
}

/** Official 2.1.160 `tc5`. */
export async function readWriteFile(
  file: NonNullable<DesignSyncInput['files']>[number],
  localDir: string | undefined,
): Promise<{
  path: string
  data: string
  encoding?: 'base64'
  mimeType?: string
}> {
  const dest = normalizeDesignPath(file.path)
  if (file.localPath === undefined) {
    if (file.data === undefined) {
      throw new Error(`write_files: ${dest} has neither data nor localPath`)
    }
    return {
      path: dest,
      data: file.data,
      encoding: file.encoding,
      mimeType: file.mimeType,
    }
  }
  if (file.data !== undefined) {
    throw new Error(`write_files: ${dest} has both data and localPath`)
  }
  if (localDir === undefined) {
    throw new Error(
      'write_files with localPath requires a plan finalized with localDir. Re-run finalize_plan with the bundle directory.',
    )
  }
  const withSep = (p: string) => (p.endsWith(sep) ? p : p + sep)
  const root = resolve(localDir)
  const candidate = resolve(root, file.localPath)
  if (candidate !== root && !candidate.startsWith(withSep(root))) {
    throw new Error(
      'write_files: localPath must be inside the directory approved at finalize_plan.',
    )
  }
  const [resolvedFile, resolvedRoot] = await Promise.all([
    realpath(candidate),
    realpath(root),
  ])
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(withSep(resolvedRoot))) {
    throw new Error(
      'write_files: localPath resolves outside the directory approved at finalize_plan.',
    )
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const handle = await open(resolvedFile, fsConstants.O_RDONLY | noFollow)
  let bytes: Buffer
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new Error('write_files: localPath must be a regular file.')
    }
    if (stats.size > MAX_WRITE_FILE_BYTES) {
      throw new Error(
        `write_files: file at localPath exceeds the ${MAX_WRITE_FILE_BYTES} byte limit.`,
      )
    }
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const ext = extname(resolvedFile).slice(1).toLowerCase()
  return TEXT_MIME_EXTENSIONS.has(ext)
    ? { path: dest, data: bytes.toString('utf8'), mimeType: file.mimeType }
    : {
        path: dest,
        data: bytes.toString('base64'),
        encoding: 'base64',
        mimeType: file.mimeType,
      }
}

/** Official 2.1.160 `ec5`. */
export async function dispatchDesignSync(
  input: DesignSyncInput,
  accessToken: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  switch (input.method) {
    case 'list_projects': {
      const { items } = await listOrgProjects(
        accessToken,
        { type: PROJECT_TYPE_DESIGN_SYSTEM },
        signal,
      )
      return {
        method: 'list_projects',
        projects: items
          .filter(
            item =>
              (item.canEdit as boolean | undefined) ??
              (item.isOwned as boolean | undefined) ??
              false,
          )
          .map(item => ({
            projectId: item.projectId,
            name: item.name,
            ownerDisplayName: item.ownerDisplayName,
            isOwned: item.isOwned,
            updatedAt: item.updatedAt,
          })),
      }
    }
    case 'get_project': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const project = await getProject(accessToken, projectId, signal)
      return {
        method: 'get_project',
        projectId: project.projectId,
        name: project.name,
        type: project.type,
        ownerDisplayName: project.ownerDisplayName,
        isOwned: project.isOwned,
        canEdit: project.canEdit,
      }
    }
    case 'list_files': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      return {
        method: 'list_files',
        paths: await listFiles(accessToken, projectId, signal),
      }
    }
    case 'get_file': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const filePath = requireField(input.path, 'path', input.method)
      const file = await getFile(
        accessToken,
        projectId,
        filePath,
        undefined,
        signal,
      )
      return {
        method: 'get_file',
        path: filePath,
        content: file.content,
        contentType: file.contentType,
        isBase64: file.isBase64,
        truncated: file.truncated,
      }
    }
    case 'finalize_plan': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const writes = requireField(input.writes, 'writes', input.method).map(
        normalizeDesignPath,
      )
      const deletes = requireField(input.deletes, 'deletes', input.method).map(
        normalizeDesignPath,
      )
      const localDir = await resolveLocalDir(input.localDir)
      return {
        method: 'finalize_plan',
        planId: registerPlan({ projectId, writes, deletes, localDir }),
        writes,
        deletes,
      }
    }
    case 'write_files': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const planId = requireField(input.planId, 'planId', input.method)
      const files = requireField(input.files, 'files', input.method)
      const plan = getPlan(planId)
      if (!plan || plan.projectId !== projectId) {
        throw new Error(
          'Plan token is missing or does not match this project. Call finalize_plan first.',
        )
      }
      const reserved = files.map(file => file.path).filter(isReservedDesignPath)
      if (reserved.length > 0) {
        throw new Error(
          `Cannot write reserved paths: ${reserved.join(', ')}. CLAUDE.md and .claude/ carry instructions to the design agent and are blocked regardless of the plan.`,
        )
      }
      const outside = files
        .map(file => normalizeDesignPath(file.path))
        .filter(p => !pathMatchesPlan(p, plan.writes))
      if (outside.length > 0) {
        throw new Error(
          `Cannot write paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      const batch = 32
      const prepared: Array<Awaited<ReturnType<typeof readWriteFile>>> = []
      for (let i = 0; i < files.length; i += batch) {
        if (signal.aborted) throw new AbortError()
        const chunk = files.slice(i, i + batch)
        prepared.push(
          ...(await Promise.all(chunk.map(file => readWriteFile(file, plan.localDir)))),
        )
      }
      return {
        method: 'write_files',
        written: (await writeFiles(accessToken, projectId, prepared, {}, signal))
          .length,
      }
    }
    case 'delete_files': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const planId = requireField(input.planId, 'planId', input.method)
      const paths = requireField(input.paths, 'paths', input.method)
      const plan = getPlan(planId)
      if (!plan || plan.projectId !== projectId) {
        throw new Error(
          'Plan token is missing or does not match this project. Call finalize_plan first.',
        )
      }
      const reserved = paths.filter(isReservedDesignPath)
      if (reserved.length > 0) {
        throw new Error(
          `Cannot delete reserved paths: ${reserved.join(', ')}. CLAUDE.md and .claude/ carry instructions to the design agent and are blocked regardless of the plan.`,
        )
      }
      const outside = paths
        .map(normalizeDesignPath)
        .filter(p => !pathMatchesPlan(p, plan.deletes))
      if (outside.length > 0) {
        throw new Error(
          `Cannot delete paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      return {
        method: 'delete_files',
        deleted: await deleteFiles(
          accessToken,
          projectId,
          paths.map(normalizeDesignPath),
          signal,
        ),
      }
    }
    case 'register_assets': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const planId = requireField(input.planId, 'planId', input.method)
      const assets = requireField(input.assets, 'assets', input.method)
      const plan = getPlan(planId)
      if (!plan || plan.projectId !== projectId) {
        throw new Error(
          'Plan token is missing or does not match this project. Call finalize_plan first.',
        )
      }
      const outside = assets
        .map(asset => normalizeDesignPath(asset.path))
        .filter(p => !pathMatchesPlan(p, plan.writes))
      if (outside.length > 0) {
        throw new Error(
          `Cannot register paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      let registered = 0
      for (const asset of assets) {
        if (signal.aborted) throw new AbortError()
        await recordAsset(
          accessToken,
          projectId,
          { ...asset, path: normalizeDesignPath(asset.path) },
          signal,
        )
        registered++
      }
      return { method: 'register_assets', registered }
    }
    case 'unregister_assets': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const planId = requireField(input.planId, 'planId', input.method)
      const paths = requireField(input.paths, 'paths', input.method)
      const plan = getPlan(planId)
      if (!plan || plan.projectId !== projectId) {
        throw new Error(
          'Plan token is missing or does not match this project. Call finalize_plan first.',
        )
      }
      const outside = paths
        .map(normalizeDesignPath)
        .filter(p => !pathMatchesPlan(p, plan.deletes))
      if (outside.length > 0) {
        throw new Error(
          `Cannot unregister cards for paths outside the finalized plan's deletes: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      let unregistered = 0
      for (const assetPath of paths.map(normalizeDesignPath)) {
        if (signal.aborted) throw new AbortError()
        await deleteAsset(accessToken, projectId, assetPath, signal)
        unregistered++
      }
      return { method: 'unregister_assets', unregistered }
    }
    case 'create_project': {
      const name = requireField(input.name, 'name', input.method)
      const created = await createProject(accessToken, name, signal)
      return {
        method: 'create_project',
        projectId: created.projectId,
        name: created.name,
      }
    }
    case 'report_validate':
      return { method: 'report_validate' }
    default:
      throw new Error(`Unknown DesignSync method: ${input.method}`)
  }
}

export { isGlobPath }
