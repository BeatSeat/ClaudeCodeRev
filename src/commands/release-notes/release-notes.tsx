import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  CHANGELOG_URL,
  fetchAndStoreChangelog,
  getAllReleaseNotes,
  getStoredChangelog,
} from '../../utils/releaseNotes.js'
import { gt } from '../../utils/semver.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'

const SHOW_ALL = '__show_all__'

function newestFirst(
  notes: Array<[string, string[]]>,
): Array<[string, string[]]> {
  return notes.sort((a, b) => (gt(a[0], b[0]) ? -1 : 1))
}

function formatReleaseNotes(notes: Array<[string, string[]]>): string {
  return notes
    .map(([version, items]) => formatVersionNotes(version, items))
    .join('\n\n')
}

function formatVersionNotes(version: string, notes: string[]): string {
  const header = `Version ${version}:`
  const bulletPoints = notes.map(note => `· ${note}`).join('\n')
  return `${header}\n${bulletPoints}`
}

function ReleaseNotesPicker({
  notes,
  onDone,
}: {
  notes: Array<[string, string[]]>
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const options = [
    {
      label: 'Show all',
      description: `${notes.length} versions`,
      value: SHOW_ALL,
    },
    ...notes.map(([version, items]) => ({
      label: `Version ${version}`,
      description: `${items.length} ${items.length === 1 ? 'item' : 'items'}`,
      value: version,
    })),
  ]

  return (
    <Dialog
      title="Release notes"
      onCancel={() => onDone(undefined, { display: 'skip' })}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Select a version to view its notes.</Text>
      </Box>
      <Select
        options={options}
        visibleOptionCount={10}
        onChange={value => {
          if (value === SHOW_ALL) {
            onDone(formatReleaseNotes(notes), { display: 'system' })
            return
          }
          const selected = notes.find(([version]) => version === value)
          if (!selected) {
            onDone(undefined, { display: 'skip' })
            return
          }
          onDone(formatVersionNotes(selected[0], selected[1]), {
            display: 'system',
          })
        }}
        onCancel={() => onDone(undefined, { display: 'skip' })}
      />
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  let notes: Array<[string, string[]]> = []

  try {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(rej => rej(new Error('Timeout')), 500, reject)
    })

    await Promise.race([fetchAndStoreChangelog(), timeoutPromise])
    notes = newestFirst(getAllReleaseNotes(await getStoredChangelog()))
  } catch {
    notes = newestFirst(getAllReleaseNotes(await getStoredChangelog()))
  }

  if (notes.length === 0) {
    onDone(`See the full changelog at: ${CHANGELOG_URL}`, { display: 'system' })
    return null
  }

  return <ReleaseNotesPicker notes={notes} onDone={onDone} />
}
