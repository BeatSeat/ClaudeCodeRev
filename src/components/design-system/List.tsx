import React, {
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
} from 'react'
import { Box, NoSelect, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

/**
 * Official 2.1.178 `XK` / `JAf`+`XAf`+`LAf` — tree/outline list used by
 * doctor (`TZ`/`o49`/`n49`/`E49`/`v49`) and settings errors (`nF8`).
 */
const GLYPHS = {
  branch: '\u251C',
  last: '\u2514',
  pipe: '\u2502',
  space: '',
} as const

type Variant = 'outline' | 'tree'
type Connector = keyof typeof GLYPHS

const ListContext = createContext<{
  variant: Variant
  ancestors: Connector[]
}>({ variant: 'outline', ancestors: [] })

const LastChildContext = createContext(true)

function wrapChildren(children: ReactNode, markLast = true): ReactNode[] {
  const items = React.Children.toArray(children)
  return items.map((child, i) => (
    <LastChildContext.Provider
      key={i}
      value={markLast && i === items.length - 1}
    >
      {child}
    </LastChildContext.Provider>
  ))
}

type ListProps = {
  children?: ReactNode
  variant?: Variant
}

function ListRoot({ children, variant = 'outline' }: ListProps): React.ReactNode {
  return (
    <ListContext.Provider value={{ variant, ancestors: [] }}>
      <Box flexDirection="column">{wrapChildren(children)}</Box>
    </ListContext.Provider>
  )
}

type NodeProps = {
  label?: ReactNode
  children?: ReactNode
  dimColor?: boolean
  color?: keyof Theme
}

function Node({
  label,
  children,
  dimColor,
  color,
}: NodeProps): React.ReactNode {
  const { variant, ancestors } = useContext(ListContext)
  const isLast = useContext(LastChildContext)
  const connector: Connector = variant === 'outline' ? 'last' : isLast ? 'last' : 'branch'
  const childPipe: Connector = variant === 'outline' ? 'space' : isLast ? 'space' : 'pipe'
  const hasLabel = label != null && label !== false
  const body = hasLabel ? label : children
  const content = isValidElement(body) ? (
    body
  ) : (
    <Text dimColor={dimColor} color={color}>
      {body}
    </Text>
  )
  const connectors = [...ancestors, connector]

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {connectors.length > 0 && (
          <NoSelect fromLeftEdge flexShrink={0} flexDirection="row">
            {connectors.map((glyph, i) => (
              <Box key={i} width={2}>
                <Text dimColor>{GLYPHS[glyph]}</Text>
              </Box>
            ))}
          </NoSelect>
        )}
        <Box flexGrow={1} flexShrink={1}>
          {content}
        </Box>
      </Box>
      {hasLabel && (
        <ListContext.Provider
          value={{ variant, ancestors: [...ancestors, childPipe] }}
        >
          {wrapChildren(children)}
        </ListContext.Provider>
      )}
    </Box>
  )
}

function Group({ children }: { children?: ReactNode }): React.ReactNode {
  const isLast = useContext(LastChildContext)
  return <>{wrapChildren(children, isLast)}</>
}

export const List = Object.assign(ListRoot, { Node, Group })
