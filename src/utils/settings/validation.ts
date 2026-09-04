import type { ConfigScope } from 'src/services/mcp/types.js'
import { z, type ZodError, type ZodIssue } from 'zod/v4'
import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import { jsonParse } from '../slowOperations.js'
import { plural } from '../stringUtils.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import {
  AllowedMcpServerEntrySchema,
  DeniedMcpServerEntrySchema,
  SettingsSchema,
} from './types.js'
import { getValidationTip } from './validationTips.js'

const KNOWN_HOOK_EVENTS = new Set<string>(HOOK_EVENTS)

/**
 * Helper type guards for specific Zod v4 issue types
 * In v4, issue types have different structures than v3
 */
function isInvalidTypeIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_type'
  expected: string
  input: unknown
} {
  return issue.code === 'invalid_type'
}

function isInvalidValueIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_value'
  values: unknown[]
  input: unknown
} {
  return issue.code === 'invalid_value'
}

function isUnrecognizedKeysIssue(
  issue: ZodIssue,
): issue is ZodIssue & { code: 'unrecognized_keys'; keys: string[] } {
  return issue.code === 'unrecognized_keys'
}

function isTooSmallIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'too_small'
  minimum: number | bigint
  origin: string
} {
  return issue.code === 'too_small'
}

/** Field path in dot notation (e.g., "permissions.defaultMode", "env.DEBUG") */
export type FieldPath = string

export type ValidationError = {
  /** Relative file path */
  file?: string
  /** Field path in dot notation */
  path: FieldPath
  /** Human-readable error message */
  message: string
  /** Expected value or type */
  expected?: string
  /** The actual invalid value that was provided */
  invalidValue?: unknown
  /** Suggestion for fixing the error */
  suggestion?: string
  /** Link to relevant documentation */
  docLink?: string
  /** 122 malformed-hooks: warning keeps the file, field is deleted */
  severity?: 'warning'
  /** MCP-specific metadata - only present for MCP configuration errors */
  mcpErrorMetadata?: {
    /** Which configuration scope this error came from */
    scope: ConfigScope
    /** The server name if error is specific to a server */
    serverName?: string
    /** Severity of the error */
    severity?: 'fatal' | 'warning'
  }
}

export type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

/**
 * Format a Zod validation error into human-readable validation errors
 */
/**
 * Get the type string for an unknown value (for error messages)
 */
function getReceivedType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function extractReceivedFromMessage(msg: string): string | undefined {
  const match = msg.match(/received (\w+)/)
  return match ? match[1] : undefined
}

export function formatZodError(
  error: ZodError,
  filePath: string,
): ValidationError[] {
  return error.issues.map((issue): ValidationError => {
    const path = issue.path.map(String).join('.')
    let message = issue.message
    let expected: string | undefined

    let enumValues: string[] | undefined
    let expectedValue: string | undefined
    let receivedValue: unknown
    let invalidValue: unknown

    if (isInvalidValueIssue(issue)) {
      enumValues = issue.values.map(v => String(v))
      expectedValue = enumValues.join(' | ')
      receivedValue = undefined
      invalidValue = undefined
    } else if (isInvalidTypeIssue(issue)) {
      expectedValue = issue.expected
      const receivedType = extractReceivedFromMessage(issue.message)
      receivedValue = receivedType ?? getReceivedType(issue.input)
      invalidValue = receivedType ?? getReceivedType(issue.input)
    } else if (isTooSmallIssue(issue)) {
      expectedValue = String(issue.minimum)
    } else if (issue.code === 'custom' && 'params' in issue) {
      const params = issue.params as { received?: unknown }
      receivedValue = params.received
      invalidValue = receivedValue
    }

    const tip = getValidationTip({
      path,
      code: issue.code,
      expected: expectedValue,
      received: receivedValue,
      enumValues,
      message: issue.message,
      value: receivedValue,
    })

    if (isInvalidValueIssue(issue)) {
      expected = enumValues?.map(v => `"${v}"`).join(', ')
      message = `Invalid value. Expected one of: ${expected}`
    } else if (isInvalidTypeIssue(issue)) {
      const receivedType =
        extractReceivedFromMessage(issue.message) ??
        getReceivedType(issue.input)
      if (
        issue.expected === 'object' &&
        receivedType === 'null' &&
        path === ''
      ) {
        message = 'Invalid or malformed JSON'
      } else {
        message = `Expected ${issue.expected}, but received ${receivedType}`
      }
    } else if (isUnrecognizedKeysIssue(issue)) {
      const keys = issue.keys.join(', ')
      message = `Unrecognized ${plural(issue.keys.length, 'field')}: ${keys}`
    } else if (isTooSmallIssue(issue)) {
      message = `Number must be greater than or equal to ${issue.minimum}`
      expected = String(issue.minimum)
    }

    return {
      file: filePath,
      path,
      message,
      expected,
      invalidValue,
      suggestion: tip?.suggestion,
      docLink: tip?.docLink,
    }
  })
}

/**
 * Validates that settings file content conforms to the SettingsSchema.
 * This is used during file edits to ensure the resulting file is valid.
 */
export function validateSettingsFileContent(content: string):
  | {
      isValid: true
    }
  | {
      isValid: false
      error: string
      fullSchema: string
    } {
  try {
    // Parse the JSON first
    const jsonData = jsonParse(content)

    // Validate against SettingsSchema in strict mode
    const result = SettingsSchema().strict().safeParse(jsonData)

    if (result.success) {
      return { isValid: true }
    }

    // Format the validation error in a helpful way
    const errors = formatZodError(result.error, 'settings')
    const errorMessage =
      'Settings validation failed:\n' +
      errors.map(err => `- ${err.path}: ${err.message}`).join('\n')

    return {
      isValid: false,
      error: errorMessage,
      fullSchema: generateSettingsJSONSchema(),
    }
  } catch (parseError) {
    return {
      isValid: false,
      error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`,
      fullSchema: generateSettingsJSONSchema(),
    }
  }
}

/**
 * Filters invalid permission rules from raw parsed JSON data before schema validation.
 * This prevents one bad rule from poisoning the entire settings file.
 * Returns warnings for each filtered rule.
 */
export function filterInvalidPermissionRules(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  if (!obj.permissions || typeof obj.permissions !== 'object') return []
  const perms = obj.permissions as Record<string, unknown>

  const warnings: ValidationError[] = []
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const rules = perms[key]
    if (!Array.isArray(rules)) continue

    perms[key] = rules.filter(rule => {
      if (typeof rule !== 'string') {
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message: `Non-string value in ${key} array was removed`,
          invalidValue: rule,
        })
        return false
      }
      const result = validatePermissionRule(rule, key)
      if (!result.valid) {
        let message = `Invalid permission rule "${rule}" was skipped`
        if (result.error) message += `: ${result.error}`
        if (result.suggestion) message += `. ${result.suggestion}`
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message,
          invalidValue: rule,
        })
        return false
      }
      return true
    })
  }
  return warnings
}

/** Official 2.1.122 `peH`: describe a rejected hooks value for the warning. */
function describeSettingsValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Official 2.1.101 QQ5 + 2.1.122 gO9: drop unknown hook event names so one
 * typo does not fail the entire settings.json parse. 122 also ignores a
 * non-object `hooks` field (delete + warning, file kept) and non-array
 * matcher entries.
 */
export function filterUnknownHookEvents(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  if (!('hooks' in obj)) return []
  if (
    obj.hooks === null ||
    typeof obj.hooks !== 'object' ||
    Array.isArray(obj.hooks)
  ) {
    const received = describeSettingsValue(obj.hooks)
    delete obj.hooks
    return [
      {
        file: filePath,
        path: 'hooks',
        message: `"hooks" must be an object mapping event names to matcher arrays; received ${received}. This field was ignored.`,
        severity: 'warning',
        invalidValue: received,
        docLink: 'https://code.claude.com/docs/en/hooks',
      },
    ]
  }
  const hooks = obj.hooks as Record<string, unknown>
  const warnings: ValidationError[] = []
  for (const eventName of Object.keys(hooks)) {
    if (!KNOWN_HOOK_EVENTS.has(eventName)) {
      delete hooks[eventName]
      warnings.push({
        file: filePath,
        path: `hooks.${eventName}`,
        message: `Unknown hook event "${eventName}" was ignored. Valid events: ${HOOK_EVENTS.join(', ')}`,
        severity: 'warning',
        invalidValue: eventName,
        docLink: 'https://code.claude.com/docs/en/hooks',
      })
      continue
    }
    if (!Array.isArray(hooks[eventName])) {
      const received = describeSettingsValue(hooks[eventName])
      delete hooks[eventName]
      warnings.push({
        file: filePath,
        path: `hooks.${eventName}`,
        message: `Hook event "${eventName}" must be an array of matchers; received ${received}. This entry was ignored.`,
        severity: 'warning',
        invalidValue: received,
        docLink: 'https://code.claude.com/docs/en/hooks',
      })
    }
  }
  if (warnings.length > 0 && Object.keys(hooks).length === 0) {
    delete obj.hooks
  }
  return warnings
}

/**
 * Official 2.1.154 `V71`/`T71`/`NBH`. Drop invalid allowedMcpServers /
 * deniedMcpServers entries so one bad managed-settings row does not fail
 * the whole settings parse.
 */
function filterInvalidMcpServerPolicyEntries(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  const warnings: ValidationError[] = []
  const fields = [
    { key: 'allowedMcpServers', schema: AllowedMcpServerEntrySchema },
    { key: 'deniedMcpServers', schema: DeniedMcpServerEntrySchema },
  ] as const
  for (const { key, schema } of fields) {
    if (!(key in obj)) continue
    const value = obj[key]
    if (!Array.isArray(value)) {
      delete obj[key]
      warnings.push({
        file: filePath,
        path: key,
        message: `"${key}" must be an array; received ${describeSettingsValue(value)}. This field was ignored.`,
        severity: 'warning',
        invalidValue: value,
      })
      continue
    }
    const kept: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const parsed = schema().safeParse(value[i])
      if (parsed.success) {
        kept.push(value[i])
      } else {
        warnings.push({
          file: filePath,
          path: `${key}[${i}]`,
          message: `Invalid entry was ignored: ${parsed.error.issues[0]?.message ?? 'failed validation'}`,
          severity: 'warning',
          invalidValue: value[i],
        })
      }
    }
    if (kept.length < value.length) {
      obj[key] = kept
    }
  }
  return warnings
}

/** Official 2.1.101 GC + 2.1.154 V71: permission-rule + unknown-hook + MCP policy.
 * 166 `sI`: managed parsing skips the MCP entry filter (the per-entry catch in
 * ManagedSettingsSchema reports those instead). */
export function filterSettingsWarnings(
  data: unknown,
  filePath: string,
  options?: { skipMcpServerEntryFilter?: boolean },
): ValidationError[] {
  return [
    ...filterInvalidPermissionRules(data, filePath),
    ...filterUnknownHookEvents(data, filePath),
    ...(options?.skipMcpServerEntryFilter
      ? []
      : filterInvalidMcpServerPolicyEntries(data, filePath)),
  ]
}

/**
 * Official 2.1.166 `omq`: sentinel a managed-policy entry catch returns so
 * the array transform can drop the entry after reporting it.
 */
const INVALID_MANAGED_POLICY_ENTRY: unique symbol = Symbol(
  'invalid-managed-policy-entry',
)

type ManagedSettingsIssue = { path: string; message: string }

/**
 * Official 2.1.166 `amq`: managed-policy entry array where each invalid entry
 * is reported (as a warning) and dropped individually, so one bad row does
 * not disable the remaining valid policies.
 */
function managedPolicyEntryArray<Schema extends z.ZodType>(
  path: string,
  entrySchema: () => Schema,
  report: (issue: ManagedSettingsIssue) => void,
) {
  return z
    .array(
      entrySchema().catch(ctx => {
        report({
          path: `${path}[]`,
          message: `Invalid entry was ignored: ${ctx.error.issues[0]?.message ?? 'failed validation'}`,
        })
        return INVALID_MANAGED_POLICY_ENTRY as unknown as z.output<Schema>
      }),
    )
    .transform(arr =>
      arr.filter(item => item !== (INVALID_MANAGED_POLICY_ENTRY as unknown)),
    )
    .optional()
}

/**
 * Official 2.1.166 `tmq`: managed-settings schema that catches each field
 * independently — one invalid field is ignored (with a warning) while the
 * remaining valid policies stay in effect. Field-level catches are replaced
 * for the policy-critical fields below, where a silent fallback is safer
 * than dropping the field.
 */
export function ManagedSettingsSchema(
  report: (issue: ManagedSettingsIssue) => void,
) {
  const settingsSchema = SettingsSchema()
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(settingsSchema.shape)) {
    shape[key] = (field as z.ZodTypeAny).catch(ctx => {
      report({
        path: key,
        message: `${ctx.error.issues[0]?.message ?? 'Failed schema validation'}. This field was ignored.`,
      })
      return undefined
    })
  }
  shape.allowedMcpServers = managedPolicyEntryArray(
    'allowedMcpServers',
    AllowedMcpServerEntrySchema,
    report,
  ).catch(() => {
    report({
      path: 'allowedMcpServers',
      message:
        '"allowedMcpServers" was present but invalid; enforcing an empty allowlist (no MCP servers admitted) until it is fixed.',
    })
    return []
  })
  shape.deniedMcpServers = managedPolicyEntryArray(
    'deniedMcpServers',
    DeniedMcpServerEntrySchema,
    report,
  ).catch(() => {
    report({
      path: 'deniedMcpServers',
      message:
        '"deniedMcpServers" was present but invalid and was dropped; its entries cannot be enforced until it is fixed.',
    })
    return undefined
  })
  shape.allowManagedMcpServersOnly = settingsSchema.shape.allowManagedMcpServersOnly.catch(
    () => {
      report({
        path: 'allowManagedMcpServersOnly',
        message:
          '"allowManagedMcpServersOnly" was present but invalid; treating it as true until it is fixed.',
      })
      return true
    },
  )
  shape.forceLoginOrgUUID = settingsSchema.shape.forceLoginOrgUUID.catch(() => {
    report({
      path: 'forceLoginOrgUUID',
      message:
        '"forceLoginOrgUUID" was present but invalid; no organization is permitted to log in until it is fixed.',
    })
    // Official 2.1.166 `tmq` returns `[]` here verbatim (zod catch value).
    return [] as unknown as string | undefined
  })
  return z
    .object(shape)
    .passthrough()
    .transform(obj => {
      for (const key of Object.keys(obj)) {
        if (obj[key] === undefined) delete obj[key]
      }
      return obj
    })
}
