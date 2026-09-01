import * as React from 'react'
import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (
  onDone,
  context,
  _args,
  commandName,
) => {
  // Official 2.1.118 Cu1: /stats alias opens the Stats tab.
  return (
    <Settings
      onClose={onDone}
      context={context}
      defaultTab={commandName === 'stats' ? 'Stats' : 'Usage'}
    />
  )
}
