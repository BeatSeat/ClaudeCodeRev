import chalk from 'chalk'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useMergedTools } from '../../hooks/useMergedTools.js'
import { Box, Text } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { Tools } from '../../Tool.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  type ResolvedAgent,
  resolveAgentOverrides,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  type AgentDefinition,
  getActiveAgentsFromList,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { Select } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'
import { AgentDetail } from './AgentDetail.js'
import { AgentEditor } from './AgentEditor.js'
import { enterTeammateView } from '../../state/teammateViewHelpers.js'
import { AgentNavigationFooter } from './AgentNavigationFooter.js'
import { AgentsList } from './AgentsList.js'
import { AgentsRunningTab } from './AgentsRunningTab.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import TextInput from '../TextInput.js'
import { deleteAgentFromFile } from './agentFileUtils.js'
import { CreateAgentWizard } from './new-agent-creation/CreateAgentWizard.js'
import type { ModeState } from './types.js'

type Props = {
  tools: Tools
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function AgentsMenu({ tools, onExit }: Props): React.ReactNode {
  const [modeState, setModeState] = useState<ModeState>({
    mode: 'list-agents',
    source: 'all',
  })
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const mcpTools = useAppState(s => s.mcp.tools)
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const tasks = useAppState(s => s.tasks)
  const usedThisSession = useAppState(s => s.agentTypesInvokedThisSession)
  const [selectedTab, setSelectedTab] = useState('running')
  const runningCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of Object.values(tasks)) {
      if (
        isLocalAgentTask(task) &&
        task.agentType !== 'main-session' &&
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'killed'
      ) {
        counts.set(task.agentType, (counts.get(task.agentType) ?? 0) + 1)
      }
    }
    return counts
  }, [tasks])
  const setAppState = useSetAppState()
  const { allAgents, activeAgents: agents } = agentDefinitions
  const [changes, setChanges] = useState<string[]>([])

  // Get MCP tools from app state and merge with local tools
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext)

  useExitOnCtrlCDWithKeybindings()

  const agentsBySource: Record<
    SettingSource | 'all' | 'built-in' | 'plugin',
    AgentDefinition[]
  > = useMemo(
    () => ({
      'built-in': allAgents.filter(a => a.source === 'built-in'),
      userSettings: allAgents.filter(a => a.source === 'userSettings'),
      projectSettings: allAgents.filter(a => a.source === 'projectSettings'),
      policySettings: allAgents.filter(a => a.source === 'policySettings'),
      localSettings: allAgents.filter(a => a.source === 'localSettings'),
      flagSettings: allAgents.filter(a => a.source === 'flagSettings'),
      plugin: allAgents.filter(a => a.source === 'plugin'),
      all: allAgents,
    }),
    [allAgents],
  )

  const handleAgentCreated = useCallback((message: string) => {
    setChanges(prev => [...prev, message])
    setModeState({ mode: 'list-agents', source: 'all' })
  }, [])

  const handleAgentDeleted = useCallback(
    async (agent: AgentDefinition) => {
      try {
        await deleteAgentFromFile(agent)
        setAppState(state => {
          const allAgents = state.agentDefinitions.allAgents.filter(
            a =>
              !(a.agentType === agent.agentType && a.source === agent.source),
          )
          return {
            ...state,
            agentDefinitions: {
              ...state.agentDefinitions,
              allAgents,
              activeAgents: getActiveAgentsFromList(allAgents),
            },
          }
        })

        setChanges(prev => [
          ...prev,
          `Deleted agent: ${chalk.bold(agent.agentType)}`,
        ])
        // Go back to the agents list after deletion
        setModeState({ mode: 'list-agents', source: 'all' })
      } catch (error) {
        logError(toError(error))
      }
    },
    [setAppState],
  )

  // Render based on mode
  switch (modeState.mode) {
    case 'list-agents': {
      const agentsToShow =
        modeState.source === 'all'
          ? [
              ...agentsBySource['built-in'],
              ...agentsBySource['userSettings'],
              ...agentsBySource['projectSettings'],
              ...agentsBySource['localSettings'],
              ...agentsBySource['policySettings'],
              ...agentsBySource['flagSettings'],
              ...agentsBySource['plugin'],
            ]
          : agentsBySource[modeState.source]

      // Resolve overrides and filter to the agents we want to show
      const allResolved = resolveAgentOverrides(agentsToShow, agents)
      const resolvedAgents: ResolvedAgent[] = allResolved
      const runningTotal = [...runningCounts.values()].reduce(
        (sum, n) => sum + n,
        0,
      )
      const handleBack = () => {
        const exitMessage =
          changes.length > 0
            ? `Agent changes:\n${changes.join('\n')}`
            : undefined
        onExit(exitMessage ?? 'Agents dialog dismissed', {
          display: changes.length === 0 ? 'system' : undefined,
        })
      }

      return (
        <>
          <Dialog
            title="Agents"
            color="permission"
            onCancel={handleBack}
            hideInputGuide
          >
            <Tabs
              color="permission"
              navFromContent
              selectedTab={selectedTab}
              onTabChange={setSelectedTab}
            >
              <Tab
                title={runningTotal > 0 ? `Running (${runningTotal})` : 'Running'}
                id="running"
              >
                <AgentsRunningTab
                  onExit={() => onExit(undefined, { display: 'skip' })}
                />
              </Tab>
              <Tab title="Library" id="definitions">
                <AgentsList
                  source={modeState.source}
                  agents={resolvedAgents}
                  onBack={handleBack}
                  onSelect={agent =>
                    setModeState({
                      mode: 'agent-menu',
                      agent,
                      previousMode: modeState,
                    })
                  }
                  onCreateNew={() => setModeState({ mode: 'create-agent' })}
                  changes={changes}
                  runningCounts={runningCounts}
                  usedThisSession={usedThisSession}
                  embedded
                />
              </Tab>
            </Tabs>
          </Dialog>
          <AgentNavigationFooter
            instructions="Tab/←→ switch tabs · ↑↓ navigate · Enter select · Esc close"
          />
        </>
      )
    }

    case 'create-agent':
      return (
        <CreateAgentWizard
          tools={mergedTools}
          existingAgents={agents}
          onComplete={handleAgentCreated}
          onCancel={() => setModeState({ mode: 'list-agents', source: 'all' })}
        />
      )

    case 'agent-menu': {
      // Always use fresh agent data
      const freshAgent = allAgents.find(
        a =>
          a.agentType === modeState.agent.agentType &&
          a.source === modeState.agent.source,
      )
      const agentToUse = freshAgent || modeState.agent

      const isEditable =
        agentToUse.source !== 'built-in' &&
        agentToUse.source !== 'plugin' &&
        agentToUse.source !== 'flagSettings'
      const runningCount = runningCounts.get(agentToUse.agentType) ?? 0
      const menuItems = [
        { label: 'Run agent', value: 'run' },
        ...(runningCount > 0
          ? [{ label: 'View running instance', value: 'view-running' }]
          : []),
        { label: 'View agent', value: 'view' },
        ...(isEditable
          ? [
              { label: 'Edit agent', value: 'edit' },
              { label: 'Delete agent', value: 'delete' },
            ]
          : []),
        { label: 'Back', value: 'back' },
      ]

      const handleMenuSelect = (value: string): void => {
        switch (value) {
          case 'run':
            setModeState({
              mode: 'run-agent',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          case 'view-running': {
            const running = Object.values(tasks).find(
              task =>
                isLocalAgentTask(task) &&
                task.agentType === agentToUse.agentType &&
                task.status !== 'completed' &&
                task.status !== 'failed' &&
                task.status !== 'killed',
            )
            if (running) {
              enterTeammateView(running.id, setAppState)
              onExit(undefined, { display: 'skip' })
            }
            break
          }
          case 'view':
            setModeState({
              mode: 'view-agent',
              agent: agentToUse,
              previousMode: modeState.previousMode,
            })
            break
          case 'edit':
            setModeState({
              mode: 'edit-agent',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          case 'delete':
            setModeState({
              mode: 'delete-confirm',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          case 'back':
            setModeState(modeState.previousMode)
            break
        }
      }

      return (
        <>
          <Dialog
            title={modeState.agent.agentType}
            onCancel={() => setModeState(modeState.previousMode)}
            hideInputGuide
          >
            <Box flexDirection="column">
              <Select
                options={menuItems}
                onChange={handleMenuSelect}
                onCancel={() => setModeState(modeState.previousMode)}
              />
              {changes.length > 0 && (
                <Box marginTop={1}>
                  <Text dimColor>{changes[changes.length - 1]}</Text>
                </Box>
              )}
            </Box>
          </Dialog>
          <AgentNavigationFooter />
        </>
      )
    }

    case 'view-agent': {
      // Always use fresh agent data from allAgents
      const freshAgent = allAgents.find(
        a =>
          a.agentType === modeState.agent.agentType &&
          a.source === modeState.agent.source,
      )
      const agentToDisplay = freshAgent || modeState.agent

      return (
        <>
          <Dialog
            title={agentToDisplay.agentType}
            onCancel={() =>
              setModeState({
                mode: 'agent-menu',
                agent: agentToDisplay,
                previousMode: modeState.previousMode,
              })
            }
            hideInputGuide
          >
            <AgentDetail
              agent={agentToDisplay}
              tools={mergedTools}
              allAgents={allAgents}
              onBack={() =>
                setModeState({
                  mode: 'agent-menu',
                  agent: agentToDisplay,
                  previousMode: modeState.previousMode,
                })
              }
            />
          </Dialog>
          <AgentNavigationFooter instructions="Press Enter or Esc to go back" />
        </>
      )
    }

    case 'delete-confirm': {
      const deleteOptions = [
        { label: 'Yes, delete', value: 'yes' },
        { label: 'No, cancel', value: 'no' },
      ]

      return (
        <>
          <Dialog
            title="Delete agent"
            onCancel={() => {
              if ('previousMode' in modeState)
                setModeState(modeState.previousMode)
            }}
            color="error"
          >
            <Text>
              Are you sure you want to delete the agent{' '}
              <Text bold>{modeState.agent.agentType}</Text>?
            </Text>
            <Box marginTop={1}>
              <Text dimColor>Source: {modeState.agent.source}</Text>
            </Box>
            <Box marginTop={1}>
              <Select
                options={deleteOptions}
                onChange={(value: string) => {
                  if (value === 'yes') {
                    void handleAgentDeleted(modeState.agent)
                  } else {
                    if ('previousMode' in modeState) {
                      setModeState(modeState.previousMode)
                    }
                  }
                }}
                onCancel={() => {
                  if ('previousMode' in modeState) {
                    setModeState(modeState.previousMode)
                  }
                }}
              />
            </Box>
          </Dialog>
          <AgentNavigationFooter instructions="Press ↑↓ to navigate, Enter to select, Esc to cancel" />
        </>
      )
    }

    case 'edit-agent': {
      // Always use fresh agent data
      const freshAgent = allAgents.find(
        a =>
          a.agentType === modeState.agent.agentType &&
          a.source === modeState.agent.source,
      )
      const agentToEdit = freshAgent || modeState.agent

      return (
        <>
          <Dialog
            title={`Edit agent: ${agentToEdit.agentType}`}
            onCancel={() => setModeState(modeState.previousMode)}
            hideInputGuide
          >
            <AgentEditor
              agent={agentToEdit}
              tools={mergedTools}
              onSaved={message => {
                handleAgentCreated(message)
                setModeState(modeState.previousMode)
              }}
              onBack={() => setModeState(modeState.previousMode)}
            />
          </Dialog>
          <AgentNavigationFooter />
        </>
      )
    }

    case 'run-agent': {
      return (
        <RunAgentPrompt
          agentType={modeState.agent.agentType}
          onExit={onExit}
          onCancel={() => setModeState(modeState.previousMode)}
        />
      )
    }

    default:
      return null
  }
}

function RunAgentPrompt({
  agentType,
  onExit,
  onCancel,
}: {
  agentType: string
  onExit: Props['onExit']
  onCancel: () => void
}): React.ReactNode {
  const [task, setTask] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)

  return (
    <Dialog
      title={`Run ${agentType}`}
      subtitle="Enter a prompt for this subagent"
      onCancel={onCancel}
    >
      <TextInput
        value={task}
        onChange={setTask}
        onSubmit={value => {
          const trimmed = value.trim()
          if (!trimmed) return
          onExit(undefined, {
            display: 'skip',
            nextInput: `@agent-${agentType} ${trimmed}`,
            submitNextInput: true,
          })
        }}
        placeholder="Describe the task…"
        columns={80}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        focus
        showCursor
      />
    </Dialog>
  )
}
