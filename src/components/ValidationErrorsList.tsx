import * as React from 'react'
import { Box, Text } from '../ink.js'
import type { ValidationError } from '../utils/settings/validation.js'
import { List } from './design-system/List.js'

/** Official 2.1.178 `Adf`/`wdf` — path last-segment as the node label. */
function settingsErrorLabel(error: ValidationError): string | undefined {
  if (!error.path) return undefined
  const parts = error.path.split('.')
  return parts[parts.length - 1] || undefined
}

export function ValidationErrorsList({
  errors,
}: {
  errors: ValidationError[]
}): React.ReactNode {
  if (errors.length === 0) {
    return null
  }

  // Group errors by file
  const errorsByFile = errors.reduce<Record<string, ValidationError[]>>(
    (acc, error) => {
      const file = error.file || '(file not specified)'
      if (!acc[file]) {
        acc[file] = []
      }
      acc[file]!.push(error)
      return acc
    },
    {},
  )

  // Sort files alphabetically
  const sortedFiles = Object.keys(errorsByFile).sort()

  return (
    <Box flexDirection="column">
      {sortedFiles.map(file => {
        const fileErrors = errorsByFile[file] || []

        // Sort errors by path
        fileErrors.sort((a, b) => {
          if (!a.path && b.path) return -1
          if (a.path && !b.path) return 1
          return (a.path || '').localeCompare(b.path || '')
        })

        // Collect unique suggestion+docLink pairs
        const suggestionPairs = new Map<
          string,
          { suggestion?: string; docLink?: string }
        >()

        fileErrors.forEach(error => {
          if (error.suggestion || error.docLink) {
            // Create a key from suggestion+docLink combination
            const key = `${error.suggestion || ''}|${error.docLink || ''}`
            if (!suggestionPairs.has(key)) {
              suggestionPairs.set(key, {
                suggestion: error.suggestion,
                docLink: error.docLink,
              })
            }
          }
        })

        return (
          <Box key={file} flexDirection="column">
            <Text>{file}</Text>
            <List variant="tree">
              {fileErrors.map((error, i) => {
                const label = settingsErrorLabel(error)
                return (
                  <List.Node key={i}>
                    {label ? (
                      <Text>
                        {label}: <Text dimColor>{error.message}</Text>
                      </Text>
                    ) : (
                      <Text dimColor>{error.message}</Text>
                    )}
                  </List.Node>
                )
              })}
            </List>
            {/* Display unique suggestion+docLink pairs */}
            {suggestionPairs.size > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {Array.from(suggestionPairs.values()).map((pair, index) => (
                  <Box
                    key={`suggestion-pair-${index}`}
                    flexDirection="column"
                    marginBottom={1}
                  >
                    {pair.suggestion && (
                      <Text dimColor wrap="wrap">
                        {pair.suggestion}
                      </Text>
                    )}
                    {pair.docLink && (
                      <Text dimColor wrap="wrap">
                        Learn more: {pair.docLink}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
