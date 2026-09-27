import type { LocalCommandCall } from '../../types/command.js'

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function getSessionEnvironment(context: Parameters<LocalCommandCall>[1]) {
  context.sessionEnvVars ??= new Map<string, string>()
  return context.sessionEnvVars
}

export const call: LocalCommandCall = async (args, context) => {
  const sessionEnvironment = getSessionEnvironment(context)
  const trimmedArgs = args.trim()

  if (!trimmedArgs) {
    if (sessionEnvironment.size === 0) {
      return {
        type: 'text',
        value: 'No session environment variables are set.',
      }
    }
    return {
      type: 'text',
      value: [...sessionEnvironment.entries()]
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    }
  }

  const unsetMatch = /^(?:unset|-u)\s+([^\s]+)$/.exec(trimmedArgs)
  if (unsetMatch) {
    const variableName = unsetMatch[1]!
    if (!ENVIRONMENT_VARIABLE_NAME.test(variableName)) {
      return {
        type: 'text',
        value: `Invalid environment variable name: ${variableName}`,
      }
    }
    sessionEnvironment.delete(variableName)
    return {
      type: 'text',
      value: `Unset ${variableName} for this session.`,
    }
  }

  const equalsIndex = trimmedArgs.indexOf('=')
  if (equalsIndex <= 0) {
    return {
      type: 'text',
      value: 'Usage: /env NAME=value or /env unset NAME',
    }
  }

  const variableName = trimmedArgs.slice(0, equalsIndex).trim()
  const variableValue = trimmedArgs.slice(equalsIndex + 1)
  if (!ENVIRONMENT_VARIABLE_NAME.test(variableName)) {
    return {
      type: 'text',
      value: `Invalid environment variable name: ${variableName}`,
    }
  }

  sessionEnvironment.set(variableName, variableValue)
  return {
    type: 'text',
    value: `Set ${variableName} for this session.`,
  }
}
