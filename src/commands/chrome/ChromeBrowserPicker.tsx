/**
 * Official 2.1.154 `Un4` / `$Az` / `Fn4` / `p$q` — Select browser picker.
 * Only opened from `/chrome` (`zAz`); do not invent a second in-chat picker.
 */

import React, { useEffect, useRef, useState } from 'react'
import { z } from 'zod/v4'
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Box, Text } from '../../ink.js'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'

type Meta = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

function featureOk(featureName: string): void {
  logEvent('tengu_feature_ok', {
    feature_name: featureName as Meta,
  })
}

function featureBad(featureName: string, errorCode: string): void {
  logEvent('tengu_feature_bad', {
    feature_name: featureName as Meta,
    error_code: errorCode as Meta,
  })
}

const ConnectedBrowserSchema = z.object({
  deviceId: z.string(),
  name: z.string().default('Browser'),
  osPlatform: z.string().optional(),
})

type ConnectedBrowser = z.infer<typeof ConnectedBrowserSchema>

/** Official 2.1.154 `Fn4`. */
async function callChromeTool(
  chromeClient: ConnectedMCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const result = await chromeClient.client.callTool({
    name,
    arguments: args,
  })
  const first = Array.isArray(result.content) ? result.content[0] : undefined
  return first &&
    typeof first === 'object' &&
    'text' in first &&
    typeof first.text === 'string'
    ? first.text
    : undefined
}

/** Official 2.1.154 `$Az`. */
async function listConnectedBrowsers(
  chromeClient: ConnectedMCPServer,
): Promise<ConnectedBrowser[]> {
  const text = await callChromeTool(chromeClient, 'list_connected_browsers', {})
  if (!text) return []
  const parsed = z
    .array(ConnectedBrowserSchema)
    .safeParse(safeParseJSON(text))
  return parsed.success ? parsed.data : []
}

/** Official 2.1.154 `p$q`. */
function BackChromeWrapper({
  onDone,
  children,
}: {
  onDone: (result?: string) => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      {children}
      <Select
        options={[{ value: 'back', label: '‹ Back' }]}
        onChange={() => onDone()}
        onCancel={() => onDone()}
        hideIndexes
      />
    </Box>
  )
}

type Props = {
  chromeClient: ConnectedMCPServer
  onDone: (result?: string) => void
}

/** Official 2.1.154 `Un4`. */
export function ChromeBrowserPicker({
  chromeClient,
  onDone,
}: Props): React.ReactNode {
  const [browsers, setBrowsers] = useState<ConnectedBrowser[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const cancelled = useRef(false)
  const pairedDeviceId = getGlobalConfig().chromeExtension?.pairedDeviceId

  useEffect(() => {
    cancelled.current = false
    void listConnectedBrowsers(chromeClient)
      .then(list => {
        if (!cancelled.current) setBrowsers(list)
      })
      .catch(err => {
        featureBad('chrome_browser_picker', 'list_failed')
        if (!cancelled.current) setListError(toError(err).message)
      })
    return () => {
      cancelled.current = true
    }
  }, [chromeClient])

  function finish(result?: string): void {
    if (cancelled.current) return
    cancelled.current = true
    onDone(result)
  }

  function handleSelect(deviceId: string): void {
    if (selecting) return
    setSelecting(true)
    const browser = browsers?.find(b => b.deviceId === deviceId)
    void callChromeTool(chromeClient, 'select_browser', { deviceId })
      .then(() => {
        featureOk('chrome_browser_picker')
        finish(
          browser
            ? `Now using browser "${browser.name}" for Chrome actions.`
            : undefined,
        )
      })
      .catch(err => {
        featureBad('chrome_browser_picker', 'select_failed')
        logForDebugging(
          `claude-in-chrome select_browser failed: ${toError(err).message}`,
          { level: 'error' },
        )
        finish(`Couldn't switch browser: ${toError(err).message}`)
      })
  }

  if (listError) {
    return (
      <BackChromeWrapper onDone={finish}>
        <Text color="error">
          Couldn't list connected browsers: {listError}
        </Text>
      </BackChromeWrapper>
    )
  }

  if (browsers === null) {
    return (
      <BackChromeWrapper onDone={finish}>
        <Text dimColor>Looking for connected browsers…</Text>
      </BackChromeWrapper>
    )
  }

  if (browsers.length === 0) {
    return (
      <BackChromeWrapper onDone={finish}>
        <Text>
          No browsers are connected. Open Chrome with the Claude extension and make sure you're signed in to the same claude.ai account.
        </Text>
      </BackChromeWrapper>
    )
  }

  const options: OptionWithDescription<string>[] = browsers.map(browser => ({
    value: browser.deviceId,
    label: (
      <>
        <Text>{browser.name}</Text>
        <Text dimColor>
          {' '}
          · {browser.osPlatform ?? 'unknown OS'}
          {browser.deviceId === pairedDeviceId ? ' · current' : ''}
        </Text>
      </>
    ),
  }))

  const header =
    browsers.length === 1
      ? 'One browser is connected:'
      : `Choose which browser to use (${browsers.length} connected):`

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{header}</Text>
      <Select
        options={options}
        onChange={handleSelect}
        onCancel={() => finish()}
        defaultFocusValue={pairedDeviceId}
        hideIndexes
      />
    </Box>
  )
}
