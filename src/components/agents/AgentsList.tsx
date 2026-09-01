import figures from 'figures'
import * as React from 'react'
import { BLACK_CIRCLE } from 'src/constants/figures.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type { ResolvedAgent } from '../../tools/AgentTool/agentDisplay.js'
import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  resolveAgentModelDisplay,
} from '../../tools/AgentTool/agentDisplay.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { count } from '../../utils/array.js'
import { Dialog } from '../design-system/Dialog.js'
import { Divider } from '../design-system/Divider.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'
import { getAgentSourceDisplayName } from './utils.js'

type Props = {
  source: SettingSource | 'all' | 'built-in' | 'plugin'
  agents: ResolvedAgent[]
  onBack: () => void
  onSelect: (agent: AgentDefinition) => void
  onCreateNew?: () => void
  changes?: string[]
  runningCounts?: Map<string, number>
  /** Official 2.1.98: types spawned this session sort first on the Library tab. */
  usedThisSession?: Set<string>
  /** Render list body only — parent Dialog/Tabs own chrome. */
  embedded?: boolean
}

export function AgentsList({
  source,
  agents,
  onBack,
  onSelect,
  onCreateNew,
  changes,
  runningCounts,
  usedThisSession,
  embedded = false,
}: Props): React.ReactNode {
  const [selectedAgent, setSelectedAgent] =
    React.useState<ResolvedAgent | null>(null)
  const [isCreateNewSelected, setIsCreateNewSelected] = React.useState(true)
  const { headerFocused, focusHeader } = useTabHeaderFocus()

  // Sort agents alphabetically by name within each source group.
  // Official 2.1.98 ddK: when viewing all + usedThisSession, used types float first.
  const sortedAgents = React.useMemo(() => {
    const byName = [...agents].sort(compareAgentsByName)
    if (source !== 'all' || !usedThisSession || usedThisSession.size === 0) {
      return byName
    }
    return byName.sort((a, b) => {
      const aUsed = usedThisSession.has(a.agentType) ? 0 : 1
      const bUsed = usedThisSession.has(b.agentType) ? 0 : 1
      return aUsed - bUsed
    })
  }, [agents, source, usedThisSession])

  const getOverrideInfo = (agent: ResolvedAgent) => {
    return {
      isOverridden: !!agent.overriddenBy,
      overriddenBy: agent.overriddenBy || null,
    }
  }

  const renderCreateNewOption = () => {
    return (
      <Box>
        <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
          {isCreateNewSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
          Create new agent
        </Text>
      </Box>
    )
  }

  const renderAgent = (agent: ResolvedAgent) => {
    const isBuiltIn = agent.source === 'built-in'
    const isSelected =
      !isBuiltIn &&
      !isCreateNewSelected &&
      selectedAgent?.agentType === agent.agentType &&
      selectedAgent?.source === agent.source

    const { isOverridden, overriddenBy } = getOverrideInfo(agent)
    const dimmed = isBuiltIn || isOverridden
    const textColor = !isBuiltIn && isSelected ? 'suggestion' : undefined
    const running = isOverridden
      ? 0
      : (runningCounts?.get(agent.agentType) ?? 0)

    const resolvedModel = resolveAgentModelDisplay(agent)

    return (
      <Box key={`${agent.agentType}-${agent.source}`}>
        <Text dimColor={dimmed && !isSelected} color={textColor}>
          {isBuiltIn ? '' : isSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Text dimColor={dimmed && !isSelected} color={textColor}>
          {agent.agentType}
        </Text>
        {resolvedModel && (
          <Text dimColor={true} color={textColor}>
            {' · '}
            {resolvedModel}
          </Text>
        )}
        {agent.memory && (
          <Text dimColor={true} color={textColor}>
            {' · '}
            {agent.memory} memory
          </Text>
        )}
        {running > 0 && (
          <Text color="success">
            {' '}
            {BLACK_CIRCLE} {running} running
          </Text>
        )}
        {overriddenBy && (
          <Text
            dimColor={!isSelected}
            color={isSelected ? 'warning' : undefined}
          >
            {' '}
            {figures.warning} shadowed by {getOverrideSourceLabel(overriddenBy)}
          </Text>
        )}
      </Box>
    )
  }

  const selectableAgentsInOrder = React.useMemo(() => {
    const nonBuiltIn = sortedAgents.filter(a => a.source !== 'built-in')
    if (source === 'all') {
      return AGENT_SOURCE_GROUPS.filter(g => g.source !== 'built-in').flatMap(
        ({ source: groupSource }) =>
          nonBuiltIn.filter(a => a.source === groupSource),
      )
    }
    return nonBuiltIn
  }, [sortedAgents, source])

  // Set initial selection
  React.useEffect(() => {
    if (
      !selectedAgent &&
      !isCreateNewSelected &&
      selectableAgentsInOrder.length > 0
    ) {
      if (onCreateNew) {
        setIsCreateNewSelected(true)
      } else {
        setSelectedAgent(selectableAgentsInOrder[0] || null)
      }
    }
  }, [selectableAgentsInOrder, selectedAgent, isCreateNewSelected, onCreateNew])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (embedded && headerFocused) return
    if (e.key === 'return') {
      e.preventDefault()
      if (isCreateNewSelected && onCreateNew) {
        onCreateNew()
      } else if (selectedAgent) {
        onSelect(selectedAgent)
      }
      return
    }

    if (e.key !== 'up' && e.key !== 'down') return
    e.preventDefault()

    // Handle navigation with "Create New Agent" option
    const hasCreateOption = !!onCreateNew
    const totalItems =
      selectableAgentsInOrder.length + (hasCreateOption ? 1 : 0)

    if (totalItems === 0) return

    // Calculate current position in list (0 = create new, 1+ = agents)
    let currentPosition = 0
    if (!isCreateNewSelected && selectedAgent) {
      const agentIndex = selectableAgentsInOrder.findIndex(
        a =>
          a.agentType === selectedAgent.agentType &&
          a.source === selectedAgent.source,
      )
      if (agentIndex >= 0) {
        currentPosition = hasCreateOption ? agentIndex + 1 : agentIndex
      }
    }

    // Embedded Library tab: up from the first row returns focus to the tab header.
    if (embedded && e.key === 'up' && currentPosition === 0) {
      focusHeader()
      return
    }

    // Calculate new position with wrap-around (standalone dialog).
    const newPosition =
      e.key === 'up'
        ? currentPosition === 0
          ? totalItems - 1
          : currentPosition - 1
        : currentPosition === totalItems - 1
          ? 0
          : currentPosition + 1

    // Update selection based on new position
    if (hasCreateOption && newPosition === 0) {
      setIsCreateNewSelected(true)
      setSelectedAgent(null)
    } else {
      const agentIndex = hasCreateOption ? newPosition - 1 : newPosition
      const newAgent = selectableAgentsInOrder[agentIndex]
      if (newAgent) {
        setIsCreateNewSelected(false)
        setSelectedAgent(newAgent)
      }
    }
  }

  const renderBuiltInAgentsSection = (
    title = 'Built-in (always available):',
  ) => {
    const builtInAgents = sortedAgents.filter(a => a.source === 'built-in')
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text bold dimColor>
          {title}
        </Text>
        {builtInAgents.map(renderAgent)}
      </Box>
    )
  }

  const renderAgentGroup = (title: string, groupAgents: ResolvedAgent[]) => {
    if (!groupAgents.length) return null

    const folderPath = groupAgents[0]?.baseDir

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold dimColor>
            {title}
          </Text>
          {folderPath && <Text dimColor> ({folderPath})</Text>}
        </Box>
        {groupAgents.map(agent => renderAgent(agent))}
      </Box>
    )
  }

  const sourceTitle = getAgentSourceDisplayName(source)

  const builtInAgents = sortedAgents.filter(a => a.source === 'built-in')

  const hasNoAgents =
    !sortedAgents.length ||
    (source !== 'built-in' && !sortedAgents.some(a => a.source !== 'built-in'))

  const wrap = (children: React.ReactNode): React.ReactNode => {
    if (embedded) return children
    return (
      <Dialog
        title={sourceTitle}
        subtitle={
          hasNoAgents
            ? 'No agents found'
            : `${count(sortedAgents, a => !a.overriddenBy)} agents`
        }
        onCancel={onBack}
        hideInputGuide
      >
        {children}
      </Dialog>
    )
  }

  if (hasNoAgents) {
    return wrap(
        <Box
          flexDirection="column"
          gap={1}
          tabIndex={0}
          autoFocus
          onKeyDown={handleKeyDown}
        >
          {onCreateNew && <Box>{renderCreateNewOption()}</Box>}
          <Text dimColor>
            No agents found. Create specialized subagents that Claude can
            delegate to.
          </Text>
          <Text dimColor>
            Each subagent has its own context window, custom system prompt, and
            specific tools.
          </Text>
          <Text dimColor>
            Try creating: Code Reviewer, Code Simplifier, Security Reviewer,
            Tech Lead, or UX Reviewer.
          </Text>
          {source !== 'built-in' &&
            sortedAgents.some(a => a.source === 'built-in') && (
              <>
                <Divider />
                {renderBuiltInAgentsSection()}
              </>
            )}
        </Box>,
    )
  }

  return wrap(
    <>
      {changes && changes.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{changes[changes.length - 1]}</Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
      >
        {onCreateNew && <Box marginBottom={1}>{renderCreateNewOption()}</Box>}
        {source === 'all' ? (
          <>
            {AGENT_SOURCE_GROUPS.filter(g => g.source !== 'built-in').map(
              ({ label, source: groupSource }) => (
                <React.Fragment key={groupSource}>
                  {renderAgentGroup(
                    label,
                    sortedAgents.filter(a => a.source === groupSource),
                  )}
                </React.Fragment>
              ),
            )}
            {builtInAgents.length > 0 && (
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text dimColor>
                  <Text bold>Built-in agents</Text> (always available)
                </Text>
                {builtInAgents.map(renderAgent)}
              </Box>
            )}
          </>
        ) : source === 'built-in' ? (
          <>
            <Text dimColor italic>
              Built-in agents are provided by default and cannot be modified.
            </Text>
            <Box marginTop={1} flexDirection="column">
              {sortedAgents.map(agent => renderAgent(agent))}
            </Box>
          </>
        ) : (
          <>
            {sortedAgents
              .filter(a => a.source !== 'built-in')
              .map(agent => renderAgent(agent))}
            {sortedAgents.some(a => a.source === 'built-in') && (
              <>
                <Divider />
                {renderBuiltInAgentsSection()}
              </>
            )}
          </>
        )}
      </Box>
    </>,
  )
}
