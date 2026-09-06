import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  executeTaskCreatedHooks,
  getTaskCreatedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  createTask,
  deleteTask,
  getTaskListId,
  isTodoV2Enabled,
} from '../../utils/tasks.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

// --- Official 2.1.169 malformed-input repair (coerceInput/validationErrorSteer) ---

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function hasTasksOrTodosParam(value: Record<string, unknown>): boolean {
  return 'tasks' in value || 'todos' in value
}

function hasAgentToolParam(value: Record<string, unknown>): boolean {
  return 'prompt' in value || 'subagent_type' in value
}

/** Subject backfill: first line of the description, truncated at 80 chars on a word boundary. */
function truncateSubject(description: string): string {
  const full = description.split('\n')[0].trim()
  const chars = Array.from(full)
  if (chars.length <= 80) return full
  const truncated = chars.slice(0, 80).join('')
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trim()
}

const VALID_INPUT_KEYS = new Set([
  'subject',
  'description',
  'activeForm',
  'metadata',
])
const SUBJECT_ALIASES = ['title', 'name']
const DESCRIPTION_ALIASES = ['content']
const ACTIVE_FORM_ALIASES = ['active_form']
// Task-list entry fields the model sometimes dumps into a TaskCreate call.
const KNOWN_TASK_LIST_KEYS = new Set([
  'status',
  'state',
  'priority',
  'prompt',
  'subagent_type',
  'id',
  'type',
  'owner',
  'blocks',
  'blockedBy',
  'addBlocks',
  'addBlockedBy',
])

function coerceTaskCreateInput(
  input: Record<string, unknown>,
): { input: Record<string, unknown>; shapeClass: string } | null {
  if (!isRecordObject(input)) return null
  if (hasTasksOrTodosParam(input)) return null
  const repairs: string[] = []
  const repaired = { ...input }
  if (
    hasAgentToolParam(repaired) &&
    !(
      isNonEmptyString(repaired.subject) &&
      isNonEmptyString(repaired.description)
    )
  ) {
    return null
  }
  if (
    !('subject' in repaired) &&
    !('description' in repaired) &&
    'task' in repaired
  ) {
    const task = repaired.task
    if (isNonEmptyString(task)) {
      delete repaired.task
      repaired.description = task
      repairs.push('task_wrapper_string')
    } else if (isRecordObject(task)) {
      if (hasTasksOrTodosParam(task)) return null
      if (
        hasAgentToolParam(task) &&
        !(isNonEmptyString(task.subject) && isNonEmptyString(task.description))
      ) {
        return null
      }
      delete repaired.task
      Object.assign(repaired, task)
      repairs.push('task_wrapper_object')
    } else {
      return null
    }
  }
  const aliasGroups: [string[], string][] = [
    [SUBJECT_ALIASES, 'subject'],
    [DESCRIPTION_ALIASES, 'description'],
    [ACTIVE_FORM_ALIASES, 'activeForm'],
  ]
  for (const [aliases, canonical] of aliasGroups) {
    for (const alias of aliases) {
      if (
        alias in repaired &&
        !(canonical in repaired) &&
        isNonEmptyString(repaired[alias])
      ) {
        repaired[canonical] = repaired[alias]
        delete repaired[alias]
        repairs.push(`alias_${alias}`)
      }
    }
  }
  if (isNonEmptyString(repaired.subject) && !('description' in repaired)) {
    repaired.description = repaired.subject
    repairs.push('backfill_description')
  } else if (
    isNonEmptyString(repaired.description) &&
    !('subject' in repaired)
  ) {
    repaired.subject = truncateSubject(repaired.description)
    repairs.push('backfill_subject')
  }
  if (isNonEmptyString(repaired.subject) && isNonEmptyString(repaired.description)) {
    for (const key of Object.keys(repaired)) {
      if (!VALID_INPUT_KEYS.has(key)) {
        delete repaired[key]
        repairs.push(`strip_${KNOWN_TASK_LIST_KEYS.has(key) ? key : 'other'}`)
      }
    }
    if ('activeForm' in repaired && typeof repaired.activeForm !== 'string') {
      delete repaired.activeForm
      repairs.push('drop_invalid_activeForm')
    }
    if ('metadata' in repaired && !isRecordObject(repaired.metadata)) {
      delete repaired.metadata
      repairs.push('drop_invalid_metadata')
    }
  }
  if (repairs.length === 0) return null
  return { input: repaired, shapeClass: repairs.join('+') }
}

function taskCreateValidationErrorSteer(
  input: Record<string, unknown>,
): string | null {
  if (!isRecordObject(input)) return null
  const task = isRecordObject(input.task) ? input.task : null
  if (
    hasTasksOrTodosParam(input) ||
    (task !== null && hasTasksOrTodosParam(task))
  ) {
    return 'TaskCreate creates ONE task per call and has no `tasks` or `todos` parameter. Call TaskCreate once per task, passing `subject` (a brief title) and `description` (what needs to be done) as top-level string parameters.'
  }
  if (
    (hasAgentToolParam(input) || (task !== null && hasAgentToolParam(task))) &&
    !(isNonEmptyString(input.subject) && isNonEmptyString(input.description))
  ) {
    return 'This call used Agent-tool parameters (`prompt`/`subagent_type`). TaskCreate adds an item to the task list and takes `subject` and `description` string parameters. To delegate work to a subagent, use the Agent tool instead.'
  }
  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata to attach to the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a task in the task list',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskCreate'
  },
  shouldDefer: true,
  coerceInput: coerceTaskCreateInput,
  validationErrorSteer: taskCreateValidationErrorSteer,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.subject
  },
  renderToolUseMessage() {
    return null
  },
  async call({ subject, description, activeForm, metadata }, context) {
    const taskId = await createTask(getTaskListId(), {
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata,
    })

    const blockingErrors: string[] = []
    const generator = executeTaskCreatedHooks(
      taskId,
      subject,
      description,
      getAgentName(),
      getTeamName(),
      undefined,
      context?.abortController?.signal,
      undefined,
      context,
    )
    for await (const result of generator) {
      if (result.blockingError) {
        blockingErrors.push(getTaskCreatedHookMessage(result.blockingError))
      }
    }

    if (blockingErrors.length > 0) {
      await deleteTask(getTaskListId(), taskId)
      throw new Error(blockingErrors.join('\n'))
    }

    // Auto-expand task list when creating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    return {
      data: {
        task: {
          id: taskId,
          subject,
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${task.id} created successfully: ${task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
