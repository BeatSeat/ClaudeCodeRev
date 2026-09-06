import React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  applyLoginHooks,
  Login,
  loginSuccessMessage,
} from '../login/login.js'
import { runExtraUsage } from './extra-usage-core.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  const result = await runExtraUsage()

  if (result.type === 'message') {
    onDone(result.value)
    return null
  }

  const current = getOauthAccountInfo()
  const previousAccount = current && {
    accountUuid: current.accountUuid,
    organizationUuid: current.organizationUuid,
  }
  return (
    <Login
      startingMessage={
        'Starting new login following /usage-credits. Exit with Ctrl-C to use existing account.'
      }
      onDone={async success => {
        const { bridgeDisconnected } = await applyLoginHooks(context, success, {
          previousAccount,
        })
        onDone(
          success ? loginSuccessMessage(bridgeDisconnected) : 'Login interrupted',
        )
      }}
    />
  )
}
