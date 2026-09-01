import * as React from 'react'
import { useEffect } from 'react'
import { Box, Text } from '../ink.js'
import { useAppState, useSetAppState, type AppState } from '../state/AppState.js'
import { StatusIcon } from './design-system/StatusIcon.js'

/** Official 2.1.153 `u0z` — dismiss granted/failed banner. */
const FOTW_BANNER_TIMEOUT_MS = 30_000

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND'])

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

/** Official 2.1.153 `jeH`. */
function currencySymbol(code: string): string {
  const upper = code.toUpperCase()
  return CURRENCY_SYMBOLS[upper] ?? `${upper} `
}

/** Official 2.1.153 `WD(..., "precise")`. */
function formatCreditAmountPrecise(
  amountMinorUnits: number,
  currency: string,
): string {
  const upper = currency.toUpperCase()
  const symbol = currencySymbol(upper)
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) {
    return `${symbol}${Math.round(amountMinorUnits)}`
  }
  return `${symbol}${(amountMinorUnits / 100).toFixed(2)}`
}

/** Official 2.1.153 `m0z`. */
function clearFotwClaim(state: AppState): AppState {
  return state.fotwClaim ? { ...state, fotwClaim: undefined } : state
}

/** Official 2.1.153 `B0z`. */
function selectFotwClaim(state: AppState): AppState['fotwClaim'] {
  return state.fotwClaim
}

/**
 * Official 2.1.153 `T59` — three-phase FotW credit banner.
 * Mounted in REPL immediately before PromptInput (`X59`). Not the 157 toast.
 */
export function FotwCreditBanner(): React.ReactNode {
  const fotwClaim = useAppState(selectFotwClaim)
  const setAppState = useSetAppState()
  const phase = fotwClaim?.phase
  const dismissAfterTimeout =
    phase !== undefined && phase !== 'pending'

  useEffect(() => {
    if (!dismissAfterTimeout) {
      return
    }
    const timer = setTimeout(() => {
      setAppState(clearFotwClaim)
    }, FOTW_BANNER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [dismissAfterTimeout, phase, setAppState])

  if (!fotwClaim) {
    return null
  }

  const amount = formatCreditAmountPrecise(
    fotwClaim.amountMinorUnits,
    fotwClaim.currency,
  )

  switch (fotwClaim.phase) {
    case 'pending':
      return (
        <Box paddingLeft={2}>
          <Text>
            <Text color="claude">Thanks for trying the feature of the week.</Text>
            {' '}
            {amount} in usage credits on its way!
          </Text>
        </Box>
      )
    case 'granted':
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="success">
            <StatusIcon status="success" withSpace />
            {amount} in usage credits added to your account
          </Text>
          <Text dimColor>
            Used before any purchased credits · expires in 90 days
          </Text>
        </Box>
      )
    case 'failed':
      return (
        <Box paddingLeft={2}>
          <Text color="error">
            <StatusIcon status="error" withSpace />
            Something went wrong when adding your usage credits. Contact support for help.
          </Text>
        </Box>
      )
  }
}
