import React, { useState } from 'react'
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  openInChrome,
} from '../../utils/claudeInChrome/common.js'
import { isChromeExtensionInstalled } from '../../utils/claudeInChrome/setup.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import { ChromeBrowserPicker } from './ChromeBrowserPicker.js'

const CHROME_EXTENSION_URL = 'https://claude.ai/chrome'
const CHROME_PERMISSIONS_URL = 'https://clau.de/chrome/permissions'
const CHROME_RECONNECT_URL = 'https://clau.de/chrome/reconnect'

type MenuAction =
  | 'install-extension'
  | 'reconnect'
  | 'manage-permissions'
  | 'toggle-default'
  | 'select-browser'

type Props = {
  onDone: (result?: string) => void
  isExtensionInstalled: boolean
  configEnabled: boolean | undefined
  isClaudeAISubscriber: boolean
  isWSL: boolean
}

function ClaudeInChromeMenu({
  onDone,
  isExtensionInstalled: installed,
  configEnabled,
  isClaudeAISubscriber,
  isWSL,
}: Props): React.ReactNode {
  const mcpClients = useAppState(s => s.mcp.clients)
  const [selectKey, setSelectKey] = useState(0)
  const [enabledByDefault, setEnabledByDefault] = useState(
    configEnabled ?? false,
  )
  const [showInstallHint, setShowInstallHint] = useState(false)
  const [isExtensionInstalled, setIsExtensionInstalled] = useState(installed)
  const [view, setView] = useState<'menu' | 'select-browser'>('menu')

  const isHomespace = "external" === 'ant' && isRunningOnHomespace()

  // Official 2.1.154 `MAz`: connected Chrome MCP client, not extension-installed
  const chromeClient = mcpClients.find(
    (c): c is ConnectedMCPServer =>
      c.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME && c.type === 'connected',
  )
  const isConnected = chromeClient !== undefined
  const pairedDeviceName = getGlobalConfig().chromeExtension?.pairedDeviceName

  function openUrl(url: string): void {
    if (isHomespace) {
      void openBrowser(url)
    } else {
      void openInChrome(url)
    }
  }

  function handleAction(action: MenuAction): void {
    switch (action) {
      case 'install-extension':
        setSelectKey(k => k + 1)
        setShowInstallHint(true)
        openUrl(CHROME_EXTENSION_URL)
        break
      case 'reconnect':
        setSelectKey(k => k + 1)
        void isChromeExtensionInstalled().then(installed => {
          setIsExtensionInstalled(installed)
          if (installed) {
            setShowInstallHint(false)
          }
        })
        openUrl(CHROME_RECONNECT_URL)
        break
      case 'manage-permissions':
        setSelectKey(k => k + 1)
        openUrl(CHROME_PERMISSIONS_URL)
        break
      case 'toggle-default': {
        const newValue = !enabledByDefault
        saveGlobalConfig(current => ({
          ...current,
          claudeInChromeDefaultEnabled: newValue,
        }))
        setEnabledByDefault(newValue)
        break
      }
      case 'select-browser':
        setView('select-browser')
        break
    }
  }

  const options: OptionWithDescription<MenuAction>[] = []
  const requiresExtensionSuffix = isExtensionInstalled
    ? ''
    : ' (requires extension)'

  if (!isExtensionInstalled && !isHomespace) {
    options.push({
      label: 'Install Chrome extension',
      value: 'install-extension',
    })
  }

  if (isConnected) {
    options.push({
      label: 'Select browser…',
      value: 'select-browser',
    })
  }

  options.push(
    {
      label: (
        <>
          <Text>Manage permissions</Text>
          <Text dimColor>{requiresExtensionSuffix}</Text>
        </>
      ),
      value: 'manage-permissions',
    },
    {
      label: (
        <>
          <Text>Reconnect extension</Text>
          <Text dimColor>{requiresExtensionSuffix}</Text>
        </>
      ),
      value: 'reconnect',
    },
    {
      label: `Enabled by default: ${enabledByDefault ? 'Yes' : 'No'}`,
      value: 'toggle-default',
    },
  )

  const isDisabled =
    isWSL || ("external" !== 'ant' && !isClaudeAISubscriber)

  return (
    <Dialog
      title="Claude in Chrome (Beta)"
      onCancel={() => onDone()}
      color="chromeYellow"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Claude in Chrome works with the Chrome extension to let you control
          your browser directly from Claude Code. Navigate websites, fill forms,
          capture screenshots, record GIFs, and debug with console logs and
          network requests.
        </Text>

        {isWSL && (
          <Text color="error">
            Claude in Chrome is not supported in WSL at this time.
          </Text>
        )}


        {"external" !== 'ant' && !isClaudeAISubscriber && (
          <Text color="error">
            Claude in Chrome requires a claude.ai subscription.
          </Text>
        )}

        {!isDisabled && (
          <>
            {!isHomespace && (
              <Box flexDirection="column">
                <Text>
                  Status:{' '}
                  {isConnected ? (
                    <Text color="success">Enabled</Text>
                  ) : (
                    <Text color="inactive">Disabled</Text>
                  )}
                </Text>
                <Text>
                  Extension:{' '}
                  {isExtensionInstalled ? (
                    <Text color="success">Installed</Text>
                  ) : (
                    <Text color="warning">Not detected</Text>
                  )}
                </Text>
                {isConnected && pairedDeviceName ? (
                  <Text>
                    Browser:{' '}
                    <Text color="success">{pairedDeviceName}</Text>
                  </Text>
                ) : null}
              </Box>
            )}
            {view === 'select-browser' && chromeClient ? (
              <ChromeBrowserPicker
                chromeClient={chromeClient}
                onDone={result => {
                  setView('menu')
                  setSelectKey(k => k + 1)
                  if (result) onDone(result)
                }}
              />
            ) : (
              <Select
                key={selectKey}
                options={options}
                onChange={handleAction}
                hideIndexes
              />
            )}

            {showInstallHint && (
              <Text color="warning">
                Once installed, select {'"Reconnect extension"'} to connect.
              </Text>
            )}

            <Text>
              <Text dimColor>Usage: </Text>
              <Text>claude --chrome</Text>
              <Text dimColor> or </Text>
              <Text>claude --no-chrome</Text>
            </Text>

            <Text dimColor>
              Site-level permissions are inherited from the Chrome extension.
              Manage permissions in the Chrome extension settings to control
              which sites Claude can browse, click, and type on.
            </Text>
          </>
        )}
        <Text dimColor>Learn more: https://code.claude.com/docs/en/chrome</Text>
      </Box>
    </Dialog>
  )
}

export const call = async function (
  onDone: (result?: string) => void,
): Promise<React.ReactNode> {
  const isExtensionInstalled = await isChromeExtensionInstalled()
  const config = getGlobalConfig()
  const isSubscriber = isClaudeAISubscriber()
  const isWSL = env.isWslEnvironment()

  return (
    <ClaudeInChromeMenu
      onDone={onDone}
      isExtensionInstalled={isExtensionInstalled}
      configEnabled={config.claudeInChromeDefaultEnabled}
      isClaudeAISubscriber={isSubscriber}
      isWSL={isWSL}
    />
  )
}
