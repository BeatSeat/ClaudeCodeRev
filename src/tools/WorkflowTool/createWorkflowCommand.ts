import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { PluginManifest } from '../../types/plugin.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isWorkflowsEnabled,
} from '../../utils/workflows/enabled.js'
import { listWorkflows, type DiscoveredWorkflow } from './WorkflowTool.js'

/**
 * Official 2.1.153 `Ke4`.
 */
export function createWorkflowCommand(workflow: DiscoveredWorkflow): Command {
  return {
    type: 'prompt',
    name: workflow.name,
    description: workflow.description,
    hasUserSpecifiedDescription: true,
    whenToUse: workflow.whenToUse,
    progressMessage: 'running dynamic workflow',
    contentLength: workflow.script.length,
    source:
      workflow.source === 'built-in' ? 'bundled' : workflow.source,
    loadedFrom:
      workflow.source === 'built-in'
        ? 'bundled'
        : workflow.source === 'plugin'
          ? 'plugin'
          : 'skills',
    ...(workflow.source === 'plugin' &&
      workflow.pluginManifest &&
      workflow.plugin && {
        pluginInfo: {
          pluginManifest: workflow.pluginManifest as PluginManifest,
          repository: workflow.plugin,
        },
      }),
    kind: 'workflow',
    async getPromptForCommand(args: string, _context: ToolUseContext) {
      const phases = workflow.phases
        ? `\n\nPhases:\n` +
          workflow.phases
            .map(
              phase =>
                `- ${phase.title}${phase.detail ? `: ${phase.detail}` : ''}`,
            )
            .join('\n')
        : ''
      const trimmed = args.trim()
      const nameJson = jsonStringify(workflow.name)
      const invoke = trimmed
        ? `{ name: ${nameJson}, args: ${jsonStringify(trimmed)} }`
        : `{ name: ${nameJson} }`
      return [
        {
          type: 'text' as const,
          text: `Run the "${workflow.name}" workflow.

${workflow.description}${workflow.whenToUse ? `\n\n${workflow.whenToUse}` : ''}${phases}

Invoke: Workflow(${invoke})`,
        },
      ]
    },
  }
}

/**
 * Official 2.1.153 `fjz`.
 */
export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  if (!isWorkflowsEnabled()) {
    return []
  }
  return (await listWorkflows(cwd)).map(createWorkflowCommand)
}
