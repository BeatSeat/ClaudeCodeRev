/**
 * Official 2.1.121 — inline extra-usage purchase dialog.
 *
 * Ported from the bundle's `yP1` state machine and its sub-components
 * (hP1/IP1/SP1/bP1/RP1/xP1/pP1/EP1/QP1/dP1 + the gP1 number field). The bundle
 * in-memory mock harness (`hT`) is compiled out in the shipped build, so all
 * mock branches are dropped; this talks to the real first-party billing API via
 * ./extraUsageApi.js.
 *
 * Analytics gates wired (10):
 *   tengu_extra_usage_inline_dialog_shown
 *   tengu_extra_usage_inline_dialog_cancel
 *   tengu_extra_usage_inline_dialog_enable_confirm
 *   tengu_extra_usage_inline_dialog_enable_result
 *   tengu_extra_usage_inline_dialog_buy_confirm
 *   tengu_extra_usage_inline_dialog_buy_result
 *   tengu_extra_usage_inline_dialog_adjust_limit
 *   tengu_extra_usage_inline_dialog_auto_reload
 *   tengu_extra_usage_inline_dialog_fallback_browser
 *   tengu_ember_latch
 */
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { logEvent } from '../../services/analytics/index.js'
import { logError } from '../../utils/log.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/select.js'
import TextInput from '../../components/TextInput.js'
import { fetchUtilization, type ExtraUsage } from '../../services/api/usage.js'
import { openBrowser } from '../../utils/browser.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import {
  adjustSpendLimit,
  enableExtraUsage,
  formatCurrency,
  getPricingBundles,
  getPaymentMethod,
  getPrepaidBalance,
  getPurchaseStatus,
  getUserFacingPurchaseError,
  previewTax,
  purchaseCredits,
  updateAutoReload,
  type CreditBundle,
  type ExtraUsageBalance,
  type PaymentMethod,
} from './extraUsageApi.js'

// Bundle URL constants (ZP1/Oc/TP1).
const HELP_CENTER_ARTICLE_URL =
  'https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans'
const USAGE_SETTINGS_URL = 'https://claude.ai/settings/usage'
const CONSUMER_TERMS_URL = 'https://www.anthropic.com/legal/consumer-terms'
// Polling + min-amount constants (vP1/VP1/kP1).
const PURCHASE_POLL_INTERVAL_MS = 2000
const PURCHASE_POLL_MAX_ATTEMPTS = 30
const MIN_CUSTOM_CENTS = 500

// Bundle NUH — "Visa ····4242" card descriptor.
function paymentMethodLabel(pm: PaymentMethod | null | undefined): string {
  return `${pm?.brand ?? pm?.type} ····${pm?.last4 ?? ''}`
}

type Step =
  | { s: 'loading' }
  | { s: 'error'; msg: string }
  | { s: 'not_enabled'; pm: PaymentMethod | null }
  | { s: 'enabling'; work: Promise<boolean> }
  | { s: 'adjusting' }
  | { s: 'auto_reload_saving'; enabled: boolean; work: Promise<boolean> }
  | {
      s: 'enabled'
      usage: ExtraUsage
      balance: ExtraUsageBalance | null
      pm: PaymentMethod | null
    }
  | { s: 'buy_select'; pm: PaymentMethod | null }
  | { s: 'buy_custom'; pm: PaymentMethod | null; initialCents?: number }
  | { s: 'buy_confirm'; pm: PaymentMethod | null; cents: number; bundle?: CreditBundle }
  | { s: 'buy_purchasing' }
  | { s: 'buy_success'; credit: number }
  | { s: 'buy_polling'; purchaseId: string; credit: number }
  | { s: 'adjust_limit'; current: number | null }
  | {
      s: 'auto_reload_config'
      current?: { enabled?: boolean; threshold_in_minor_units?: number; reload_to_in_minor_units?: number }
      pm: PaymentMethod | null
    }

/** Bundle SD6 — mark /extra-usage visited. */
function markExtraUsageVisited(): void {
  if (!getGlobalConfig().hasVisitedExtraUsage) {
    saveGlobalConfig(prev => ({ ...prev, hasVisitedExtraUsage: true }))
  }
}

// ---------------------------------------------------------------------------
// Async-work wrapper (bundle $L7 / cP1): run `work`, then onDone(result).
// ---------------------------------------------------------------------------
function AsyncWork({
  message,
  work,
  onDone,
}: {
  message: string
  work: Promise<boolean>
  onDone: (result: boolean) => void
}): React.ReactNode {
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone
  React.useEffect(() => {
    let cancelled = false
    work
      .then(result => {
        if (!cancelled) onDoneRef.current(result)
      })
      .catch(error => {
        logError(error as Error)
        if (!cancelled) onDoneRef.current(false)
      })
    return () => {
      cancelled = true
    }
  }, [work])
  return <LoadingState message={message} />
}

// ---------------------------------------------------------------------------
// Purchase polling (bundle QP1): poll the commit until it settles.
// ---------------------------------------------------------------------------
function PurchasePolling({
  purchaseId,
  onSuccess,
  onError,
}: {
  purchaseId: string
  onSuccess: () => void
  onError: (msg: string) => void
}): React.ReactNode {
  const onSuccessRef = React.useRef(onSuccess)
  onSuccessRef.current = onSuccess
  const onErrorRef = React.useRef(onError)
  onErrorRef.current = onError
  const attemptsRef = React.useRef(0)
  const settledRef = React.useRef(false)

  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll(): Promise<void> {
      if (cancelled || settledRef.current) return
      attemptsRef.current += 1
      if (attemptsRef.current > PURCHASE_POLL_MAX_ATTEMPTS) {
        settledRef.current = true
        onErrorRef.current(
          'Purchase timed out — check claude.ai/settings/usage',
        )
        return
      }
      try {
        const status = await getPurchaseStatus(purchaseId)
        if (cancelled || settledRef.current) return
        if (status.status === 'paid') {
          settledRef.current = true
          logEvent('tengu_extra_usage_inline_dialog_buy_result', { status: 'success' })
          onSuccessRef.current()
        } else if (status.status === 'failed') {
          settledRef.current = true
          logEvent('tengu_extra_usage_inline_dialog_buy_result', { status: 'failed' })
          onErrorRef.current('Payment failed')
        } else if (status.status === 'action_needed') {
          settledRef.current = true
          logEvent('tengu_extra_usage_inline_dialog_buy_result', {
            status: '3ds_fallback',
          })
          onErrorRef.current(
            `Your card requires additional verification — this purchase was not completed. Try again at ${USAGE_SETTINGS_URL}`,
          )
        } else {
          timer = setTimeout(poll, PURCHASE_POLL_INTERVAL_MS)
        }
      } catch (error) {
        if (cancelled || settledRef.current) return
        settledRef.current = true
        logError(error as Error)
        onErrorRef.current('Failed to check purchase status')
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [purchaseId])

  return <LoadingState message="Confirming payment… (may take a few seconds)" />
}

// ---------------------------------------------------------------------------
// Error screen (bundle EP1): Enter opens settings, Esc closes.
// ---------------------------------------------------------------------------
function ErrorScreen({
  msg,
  onClose,
}: {
  msg: string
  onClose: () => void
}): React.ReactNode {
  useKeybinding('confirm:yes', () => {
    void openBrowser(USAGE_SETTINGS_URL)
    onClose()
  })
  useKeybinding('confirm:no', onClose)
  return (
    <Dialog title="Extra usage" onCancel={onClose} color="error">
      <Box flexDirection="column" gap={1}>
        <Text color="error">{msg}</Text>
        <Text dimColor>
          {'Enter to open ' + USAGE_SETTINGS_URL + ' · Esc to close'}
        </Text>
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Purchase-success banner (bundle dP1). The bundle plays a celebrate mascot
// sequence (VUH) here; the tree has no equivalent, so it is omitted.
// ---------------------------------------------------------------------------
function BuySuccess({
  message,
  onDone,
}: {
  message: string
  onDone: () => void
}): React.ReactNode {
  useKeybinding('confirm:yes', onDone)
  useKeybinding('confirm:no', onDone)
  return (
    <Box flexDirection="row" gap={2} alignItems="center" paddingTop={1}>
      <Text color="success">{message}</Text>
      <Text dimColor>{'Enter to continue'}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Number field (bundle gP1): a single currency amount with Enter submit.
// ---------------------------------------------------------------------------
function CurrencyField({
  title,
  subtitle,
  initial,
  minCents,
  currency,
  footer,
  onSubmit,
  onCancel,
}: {
  title: string
  subtitle?: string
  initial: string
  minCents?: number
  currency: string
  footer?: string
  onSubmit: (cents: number) => void
  onCancel: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [value, setValue] = React.useState(initial)
  const [cursorOffset, setCursorOffset] = React.useState(initial.length)

  const cleaned = value.replace(/[^0-9.]/g, '')
  const parsed = parseFloat(cleaned)
  const cents = Number.isNaN(parsed) ? 0 : Math.round(parsed * 100)
  const belowMin = minCents !== undefined && cents > 0 && cents < minCents

  const handleSubmit = React.useCallback(
    () => {
      if (cents <= 0 || belowMin) return
      onSubmit(cents)
    },
    [cents, belowMin, onSubmit],
  )

  return (
    <Dialog title={title} onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Text>{currencySymbol(currency)}</Text>
          <TextInput
            focus
            showCursor
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            onExit={onCancel}
            columns={Math.max(10, columns - 12)}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {footer ? <Text dimColor>{footer}</Text> : null}
        {belowMin && minCents !== undefined ? (
          <Text color="error">
            {'Minimum is ' + formatCurrency(minCents, currency, 'whole')}
          </Text>
        ) : null}
      </Box>
    </Dialog>
  )
}

function currencySymbol(currency: string): string {
  const map: Record<string, string> = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
  }
  const code = currency.toUpperCase()
  return map[code] ?? `${code} `
}

// ---------------------------------------------------------------------------
// Not-enabled confirm (bundle hP1): turn extra usage on.
// ---------------------------------------------------------------------------
function NotEnabledConfirm({
  pm,
  onConfirm,
  onCancel,
}: {
  pm: PaymentMethod | null
  onConfirm: () => void
  onCancel: () => void
}): React.ReactNode {
  useKeybinding('confirm:yes', onConfirm)
  return (
    <Dialog
      title="Turn on extra usage"
      onCancel={onCancel}
      color="suggestion"
    >
      <Box flexDirection="column" gap={1}>
        <Text>Keep using Claude when you hit a limit.</Text>
        <Text dimColor>
          {pm
            ? `Card on file: ${paymentMethodLabel(pm)}`
            : `No card on file — add one at ${USAGE_SETTINGS_URL} before buying.`}
        </Text>
        <Text dimColor>
          {'By turning on, you agree to turn on extra usage as defined in our Help Center article:'}
          <br />
          {HELP_CENTER_ARTICLE_URL}
        </Text>
        <Text dimColor>{'Enter to turn on · Esc to cancel'}</Text>
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Enabled menu (bundle IP1): usage bar + balance + action list.
// ---------------------------------------------------------------------------
function EnabledMenu({
  usage,
  balance,
  currency,
  onAction,
  onCancel,
}: {
  usage: ExtraUsage
  balance: ExtraUsageBalance | null
  currency: string
  onAction: (action: 'auto_reload' | 'buy' | 'continue' | 'adjust' | 'manage') => void
  onCancel: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const barWidth = Math.min(columns - 6, 50)
  const used = usage.used_credits !== null ? formatCurrency(usage.used_credits, currency) : '—'
  const limit = usage.monthly_limit !== null ? formatCurrency(usage.monthly_limit, currency, 'whole') : 'Unlimited'
  const percent = usage.utilization !== null ? Math.round(usage.utilization) : 0
  const balanceLabel = balance ? formatCurrency(balance.amount ?? 0, currency) : '—'
  const autoReloadOn = balance?.auto_reload_settings?.enabled === true
  const nextMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth() + 1,
    1,
  ).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const options: OptionWithDescription<
    'auto_reload' | 'buy' | 'continue' | 'adjust' | 'manage'
  >[] = [
    {
      label: `${balanceLabel} balance · auto-reload ${autoReloadOn ? 'on' : 'off'}`,
      value: 'auto_reload',
    },
    { label: 'Buy more', value: 'buy' },
    { label: 'Continue with extra usage', value: 'continue' },
    { label: 'Adjust monthly limit', value: 'adjust' },
    { label: 'Manage on claude.ai', value: 'manage' },
  ]

  return (
    <Dialog title="Extra usage" onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text>
              {used} spent
            </Text>
            <ProgressBar
              ratio={percent / 100}
              width={barWidth}
              fillColor="rate_limit_fill"
              emptyColor="rate_limit_empty"
            />
            <Text>{percent}% used</Text>
          </Box>
          <Text dimColor>
            {`Resets ${nextMonth} · ${limit} monthly limit`}
          </Text>
        </Box>
        <Select
          options={options}
          onChange={onAction}
          onCancel={onCancel}
          visibleOptionCount={options.length}
        />
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Buy-select (bundle SP1): preset bundles + Custom + Cancel.
// ---------------------------------------------------------------------------
function BuySelect({
  pm,
  presets,
  currency,
  onConfirm,
  onCustom,
  onCancel,
}: {
  pm: PaymentMethod | null
  presets: CreditBundle[]
  currency: string
  onConfirm: (bundle: CreditBundle) => void
  onCustom: () => void
  onCancel: () => void
}): React.ReactNode {
  const options: OptionWithDescription<string>[] = [
    ...presets.map((bundle, index) => {
      const discountPct =
        bundle.credit_minor_units > 0
          ? Math.round(
              (bundle.discount_minor_units / bundle.credit_minor_units) * 100,
            )
          : 0
      return {
        label: formatCurrency(bundle.local_credit_minor_units, currency, 'fit'),
        description: discountPct > 0 ? `Save ${discountPct}%` : undefined,
        value: `p${index}`,
      }
    }),
    { label: 'Custom amount…', value: 'custom' },
    { label: 'Cancel', value: 'cancel' },
  ]

  const handleChange = React.useCallback(
    (value: string) => {
      if (value === 'custom') return onCustom()
      if (value === 'cancel') return onCancel()
      onConfirm(presets[Number(value.slice(1))])
    },
    [presets, onConfirm, onCustom, onCancel],
  )

  return (
    <Dialog title="Buy extra usage" onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{'Payment: ' + paymentMethodLabel(pm)}</Text>
        <Select
          options={options}
          onChange={handleChange}
          onCancel={onCancel}
          visibleOptionCount={options.length}
        />
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Buy-custom (bundle bP1): a free-form amount.
// ---------------------------------------------------------------------------
function BuyCustom({
  pm,
  initialCents,
  currency,
  onConfirm,
  onCancel,
}: {
  pm: PaymentMethod | null
  initialCents?: number
  currency: string
  onConfirm: (cents: number) => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <CurrencyField
      title="Buy extra usage"
      subtitle={'Payment: ' + paymentMethodLabel(pm)}
      initial={initialCents ? String(initialCents / 100) : '75'}
      minCents={currency === 'USD' ? MIN_CUSTOM_CENTS : undefined}
      currency={currency}
      footer="By confirming, you allow Anthropic to charge your card in the amount above."
      onSubmit={onConfirm}
      onCancel={onCancel}
    />
  )
}

// ---------------------------------------------------------------------------
// Buy-confirm (bundle RP1): amount + tax preview, Pay now / Go back.
// ---------------------------------------------------------------------------
type TaxPreview = {
  tax_minor_units: number
  tax_rate_pct: number
  tax_label: string | null
}

function BuyConfirm({
  pm,
  cents,
  bundle,
  currency,
  stripeProductId,
  onConfirm,
  onCancel,
}: {
  pm: PaymentMethod | null
  cents: number
  bundle?: CreditBundle
  currency: string
  stripeProductId?: string
  onConfirm: () => void
  onCancel: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const creditAmount = bundle ? bundle.local_credit_minor_units : cents
  const discountAmount = creditAmount - cents
  const discountPct =
    creditAmount > 0 && discountAmount > 0
      ? Math.round((discountAmount / creditAmount) * 100)
      : 0
  const [taxState, setTaxState] = React.useState<
    'loading' | null | TaxPreview
  >('loading')
  const taxLoading = taxState === 'loading'
  const taxUnavailable = taxState === null
  const tax = taxLoading || taxUnavailable ? 0 : taxState.tax_minor_units
  const totalCents = cents + tax

  React.useEffect(() => {
    let active = true
    previewTax(cents, currency, stripeProductId).then(result => {
      if (active) setTaxState(result)
    })
    return () => {
      active = false
    }
  }, [cents, currency, stripeProductId])

  useKeybinding('confirm:yes', onConfirm, { isActive: !taxLoading })

  const options: OptionWithDescription<'yes' | 'no'>[] = taxUnavailable
    ? [{ label: 'Go back', value: 'no' }]
    : [
        {
          label: taxLoading
            ? 'Pay (calculating…)'
            : `Pay ${formatCurrency(totalCents, currency)} now`,
          value: 'yes',
          disabled: taxLoading,
        },
        { label: 'Go back', value: 'no' },
      ]

  const barWidth = Math.max(0, Math.min(columns - 6, 44))
  const taxLabel = taxLoading || taxUnavailable ? 'Tax' : (taxState?.tax_label ?? 'Tax')

  return (
    <Dialog title="Confirm purchase" onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        <Text>{'Payment: ' + paymentMethodLabel(pm)}</Text>
        <Box>
          <Text>{formatCurrency(cents, currency)} of extra usage</Text>
          {discountPct > 0 ? (
            <Text color="success">
              {'  · Save ' + discountPct + '%'}
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="row">
          <Text dimColor>{'─'.repeat(barWidth)}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>{taxLabel}</Text>
          <Text dimColor>{formatCurrency(tax, currency)}</Text>
        </Box>
        <Select
          options={options}
          onChange={value => {
            if (value === 'yes') onConfirm()
            else onCancel()
          }}
          onCancel={onCancel}
          visibleOptionCount={options.length}
        />
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Adjust-limit (bundle xP1): set a new monthly limit or make it unlimited.
// ---------------------------------------------------------------------------
function AdjustLimit({
  current,
  currency,
  onConfirm,
  onCancel,
}: {
  current: number | null
  currency: string
  onConfirm: (cents: number | null) => void
  onCancel: () => void
}): React.ReactNode {
  const [stage, setStage] = React.useState<'choose' | 'amount'>('choose')

  if (stage === 'amount') {
    return (
      <CurrencyField
        title="Adjust monthly limit"
        subtitle="Enter the new monthly limit"
        initial={current !== null ? String(Math.round(current / 100)) : '150'}
        currency={currency}
        onSubmit={cents => onConfirm(cents)}
        onCancel={() => setStage('choose')}
      />
    )
  }

  const options: OptionWithDescription<'set' | 'unlimited' | 'cancel'>[] = [
    { label: 'Set a monthly limit…', value: 'set' },
    { label: 'Set unlimited', value: 'unlimited' },
    { label: 'Cancel', value: 'cancel' },
  ]
  return (
    <Dialog title="Adjust monthly limit" onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {current !== null
            ? `Current monthly limit: ${formatCurrency(current, currency, 'whole')}`
            : 'No monthly limit set (unlimited)'}
        </Text>
        <Select
          options={options}
          onChange={value => {
            if (value === 'set') setStage('amount')
            else if (value === 'unlimited') onConfirm(null)
            else onCancel()
          }}
          onCancel={onCancel}
          visibleOptionCount={options.length}
        />
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Auto-reload config (bundle pP1): threshold + reload-to, save / off / cancel.
// ---------------------------------------------------------------------------
function AutoReloadAmounts({
  current,
  currency,
  onSave,
  onBack,
  onCancel,
}: {
  current?: { enabled?: boolean; threshold_in_minor_units?: number; reload_to_in_minor_units?: number }
  currency: string
  onSave: (thresholdCents: number, reloadToCents: number) => void
  onBack: () => void
  onCancel: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [threshold, setThreshold] = React.useState(
    current?.threshold_in_minor_units
      ? String(Math.round(current.threshold_in_minor_units / 100))
      : '5',
  )
  const [reloadTo, setReloadTo] = React.useState(
    current?.reload_to_in_minor_units
      ? String(Math.round(current.reload_to_in_minor_units / 100))
      : '15',
  )
  const [tCursor, setTCursor] = React.useState(
    current?.threshold_in_minor_units
      ? String(Math.round(current.threshold_in_minor_units / 100)).length
      : 1,
  )

  const toCents = (raw: string): number => {
    const value = parseFloat(raw.replace(/[^0-9.]/g, ''))
    return Number.isNaN(value) || value <= 0 ? 0 : Math.round(value * 100)
  }
  const thresholdCents = toCents(threshold)
  const reloadToCents = toCents(reloadTo)
  const validation =
    thresholdCents <= 0 || reloadToCents <= 0
      ? 'Enter an amount'
      : reloadToCents <= thresholdCents
        ? 'Reload-to must be above threshold'
        : currency === 'USD' && reloadToCents - thresholdCents < 1000
          ? `Reload must be at least ${formatCurrency(1000, currency, 'whole')} above threshold`
          : ''
  const valid = validation === ''

  const save = () => {
    if (!valid) return
    onSave(thresholdCents, reloadToCents)
  }

  return (
    <Dialog title="Auto-reload" onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>Threshold (auto-buy when balance is below):</Text>
          <Box borderStyle="single" borderColor="suggestion" paddingX={1}>
            <TextInput
              focus
              showCursor
              value={threshold}
              onChange={setThreshold}
              onSubmit={save}
              onExit={onBack}
              onHistoryDown={onBack}
              columns={Math.max(10, columns - 16)}
              cursorOffset={tCursor}
              onChangeCursorOffset={setTCursor}
            />
          </Box>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Reload balance to:</Text>
          <Box borderStyle="single" borderColor="inactive" paddingX={1}>
            <TextInput
              showCursor
              value={reloadTo}
              onChange={setReloadTo}
              onSubmit={save}
              onHistoryUp={onBack}
              columns={Math.max(10, columns - 16)}
            />
          </Box>
        </Box>
        {validation ? <Text color="error">{validation}</Text> : null}
        <Text dimColor>{'Enter to save · Esc to go back'}</Text>
      </Box>
    </Dialog>
  )
}

function AutoReloadConfig({
  current,
  pm,
  currency,
  onSave,
  onTurnOff,
  onCancel,
}: {
  current?: { enabled?: boolean; threshold_in_minor_units?: number; reload_to_in_minor_units?: number }
  pm: PaymentMethod | null
  currency: string
  onSave: (thresholdCents: number, reloadToCents: number) => void
  onTurnOff: () => void
  onCancel: () => void
}): React.ReactNode {
  const [stage, setStage] = React.useState<'menu' | 'amounts'>('menu')
  const currentlyOn = current?.enabled === true

  if (stage === 'amounts') {
    return (
      <AutoReloadAmounts
        current={current}
        currency={currency}
        onSave={onSave}
        onBack={() => setStage('menu')}
        onCancel={onCancel}
      />
    )
  }

  const options: OptionWithDescription<'save' | 'off' | 'cancel'>[] = currentlyOn
    ? [
        { label: 'Agree and save', value: 'save' },
        { label: 'Turn off', value: 'off' },
        { label: 'Cancel', value: 'cancel' },
      ]
    : [
        { label: 'Agree and save', value: 'save' },
        { label: 'Cancel', value: 'cancel' },
      ]

  return (
    <Dialog title="Auto-reload" onCancel={onCancel} color="suggestion">
      <Box flexDirection="column" gap={1}>
        <Text>
          Automatically buy more extra usage when your balance is low.
          {currentlyOn ? <Text color="success"> · Currently on</Text> : null}
        </Text>
        <Text dimColor>{'Payment: ' + paymentMethodLabel(pm)}</Text>
        <Text dimColor>
          {`By selecting Agree, you authorize Anthropic to automatically charge ${paymentMethodLabel(pm)} on a recurring basis whenever your balance reaches the threshold, per the Consumer Terms (${CONSUMER_TERMS_URL}). Turn off any time here or at ${USAGE_SETTINGS_URL}.`}
        </Text>
        <Select
          options={options}
          onChange={value => {
            if (value === 'save') setStage('amounts')
            else if (value === 'off') onTurnOff()
            else onCancel()
          }}
          onCancel={onCancel}
          visibleOptionCount={options.length}
        />
      </Box>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// The dialog (bundle yP1): the step state machine.
// ---------------------------------------------------------------------------
export function ExtraUsageDialog({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
}): React.ReactNode {
  const [step, setStep] = React.useState<Step>({ s: 'loading' })
  const [currency, setCurrency] = React.useState('USD')
  const [bundles, setBundles] = React.useState<CreditBundle[]>([])
  const [stripeProductId, setStripeProductId] = React.useState<string | undefined>()

  // Bundle O — load (or reload) the extra-usage status.
  const load = React.useCallback(
    async (withLoading = true): Promise<void> => {
      if (withLoading) setStep({ s: 'loading' })
      try {
        const [utilization, balance, paymentMethod, pricing] =
          await Promise.all([
            fetchUtilization(),
            getPrepaidBalance(),
            getPaymentMethod(),
            getPricingBundles(),
          ])
        setCurrency((pricing?.currency ?? balance?.currency ?? 'USD').toUpperCase())
        setBundles(pricing?.bundles ?? [])
        setStripeProductId(pricing?.stripe_product_id)

        const usage =
          utilization?.extra_usage ??
          ({
            is_enabled: false,
            monthly_limit: null,
            used_credits: null,
            utilization: null,
          } as ExtraUsage)
        if (!usage.is_enabled) {
          setStep({ s: 'not_enabled', pm: paymentMethod })
          return
        }
        setStep({ s: 'enabled', usage, balance, pm: paymentMethod })
      } catch (error) {
        logError(error as Error)
        setStep({
          s: 'error',
          msg: 'Failed to load extra usage status',
        })
      }
    },
    [],
  )

  React.useEffect(() => {
    markExtraUsageVisited()
    logEvent('tengu_extra_usage_inline_dialog_shown', {})
    void load()
  }, [load])

  // Bundle M — cancel (gate: cancel with from_step).
  const cancel = (fromStep: string) => {
    logEvent('tengu_extra_usage_inline_dialog_cancel', { from_step: fromStep })
    onDone(undefined, { display: 'skip' })
  }

  // Bundle D — enable (gates: enable_confirm / enable_result).
  const enable = () => {
    logEvent('tengu_extra_usage_inline_dialog_enable_confirm', {})
    setStep({
      s: 'enabling',
      work: enableExtraUsage().then(async success => {
        logEvent('tengu_extra_usage_inline_dialog_enable_result', { success })
        if (!success) return false
        saveGlobalConfig(prev => {
          if (!prev.oauthAccount) return prev
          if (prev.oauthAccount.hasExtraUsageEnabled === true) return prev
          return {
            ...prev,
            oauthAccount: { ...prev.oauthAccount, hasExtraUsageEnabled: true },
          }
        })
        await load(false)
        return true
      }),
    })
  }

  // Bundle w — enable result handler.
  const handleEnableDone = (success: boolean) => {
    if (!success) setStep({ s: 'error', msg: 'Failed to turn on extra usage' })
  }

  // Bundle j — enabled-menu action dispatch.
  const handleAction = (action: string, enabledStep: Extract<Step, { s: 'enabled' }>) => {
    switch (action) {
      case 'continue':
        onDone('Continuing with extra usage')
        break
      case 'buy':
        if (!enabledStep.pm) {
          logEvent('tengu_extra_usage_inline_dialog_fallback_browser', {
            reason: 'no_payment_method',
          })
          onDone(
            `No card on file — add a payment method at ${USAGE_SETTINGS_URL}`,
          )
        } else {
          setStep({ s: 'buy_select', pm: enabledStep.pm })
        }
        break
      case 'adjust':
        setStep({ s: 'adjust_limit', current: enabledStep.usage.monthly_limit })
        break
      case 'auto_reload':
        if (!enabledStep.pm) {
          logEvent('tengu_extra_usage_inline_dialog_fallback_browser', {
            reason: 'no_payment_method',
          })
          onDone(
            `No card on file — add a payment method at ${USAGE_SETTINGS_URL}`,
          )
        } else {
          setStep({
            s: 'auto_reload_config',
            current: enabledStep.balance?.auto_reload_settings,
            pm: enabledStep.pm,
          })
        }
        break
      case 'manage':
        void openBrowser(USAGE_SETTINGS_URL)
        onDone(`Opening ${USAGE_SETTINGS_URL}`)
        break
    }
  }

  // Bundle X — auto-reload save (gate: auto_reload).
  const handleAutoReloadSave = (
    enabled: boolean,
    thresholdCents: number,
    reloadToCents: number,
  ) => {
    logEvent('tengu_extra_usage_inline_dialog_auto_reload', {
      enabled,
      threshold_cents: thresholdCents,
      reload_to_cents: reloadToCents,
      currency,
    })
    const base = updateAutoReload(enabled, thresholdCents, reloadToCents, currency)
    const work = enabled
      ? base.then(async result => {
          if (result) await load(false)
          return result
        })
      : base
    setStep({ s: 'auto_reload_saving', enabled, work })
  }

  // Bundle J — auto-reload save result handler.
  const handleAutoReloadDone = (success: boolean, wasEnabling: boolean) => {
    if (!success) {
      setStep({ s: 'error', msg: 'Failed to update auto-reload' })
      return
    }
    if (!wasEnabling) void load(false)
  }

  // Bundle L — purchase (gates: buy_confirm / buy_result).
  const handleBuy = (cents: number, bundle?: CreditBundle) => {
    logEvent('tengu_extra_usage_inline_dialog_buy_confirm', {
      amount_cents: cents,
      preset: !!bundle,
      currency,
    })
    setStep({ s: 'buy_purchasing' })
    const credit = bundle ? bundle.local_credit_minor_units : cents
    purchaseCredits(
      bundle
        ? { kind: 'bundle', bundle }
        : { kind: 'custom', amountCents: cents },
    )
      .then(result => {
        if (result.payment_status === 'success') {
          logEvent('tengu_extra_usage_inline_dialog_buy_result', {
            status: 'success',
          })
          setStep({ s: 'buy_success', credit })
        } else if (
          result.payment_status === 'pending_invoice' &&
          result.purchase_id
        ) {
          setStep({ s: 'buy_polling', purchaseId: result.purchase_id, credit })
        } else if (result.payment_status === 'requires_action') {
          logEvent('tengu_extra_usage_inline_dialog_buy_result', {
            status: '3ds_fallback',
          })
          setStep({
            s: 'error',
            msg: `Your card requires additional verification — this purchase was not completed. Try again at ${USAGE_SETTINGS_URL}`,
          })
        } else {
          setStep({ s: 'error', msg: 'Unexpected purchase state' })
        }
      })
      .catch(error => {
        logError(error as Error)
        logEvent('tengu_extra_usage_inline_dialog_buy_result', { status: 'failed' })
        const userFacing = getUserFacingPurchaseError(error)
        setStep({
          s: 'error',
          msg: userFacing ? `Purchase failed: ${userFacing}` : 'Purchase failed',
        })
      })
  }

  // Bundle P — adjust limit (gate: adjust_limit).
  const handleAdjustLimit = async (cents: number | null, oldCents: number | null) => {
    logEvent('tengu_extra_usage_inline_dialog_adjust_limit', {
      old_cents: oldCents ?? undefined,
      new_cents: cents ?? undefined,
      unlimited: cents === null,
      currency,
    })
    setStep({ s: 'adjusting' })
    if (!(await adjustSpendLimit(cents, currency))) {
      setStep({ s: 'error', msg: 'Failed to update spend limit' })
      return
    }
    onDone(
      cents === null
        ? 'Monthly limit set to unlimited'
        : `Monthly limit updated to ${formatCurrency(cents, currency, 'whole')}`,
    )
  }

  switch (step.s) {
    case 'loading':
      return (
        <Box paddingTop={1}>
          <LoadingState message="Loading extra usage status…" />
        </Box>
      )
    case 'enabling':
      return (
        <AsyncWork
          message="Turning on extra usage…"
          work={step.work}
          onDone={handleEnableDone}
        />
      )
    case 'adjusting':
      return (
        <Box paddingTop={1}>
          <LoadingState message="Updating spend limit…" />
        </Box>
      )
    case 'auto_reload_saving':
      return (
        <AsyncWork
          message={step.enabled ? 'Turning on auto-reload…' : 'Turning off auto-reload…'}
          work={step.work}
          onDone={success => handleAutoReloadDone(success, step.enabled)}
        />
      )
    case 'buy_purchasing':
      return <LoadingState message="Processing payment… (may take a few seconds)" />
    case 'buy_success': {
      const label = formatCurrency(step.credit, currency)
      return (
        <BuySuccess
          message={`Added ${label} of extra usage`}
          onDone={() => onDone(`Added ${label} of extra usage`)}
        />
      )
    }
    case 'buy_polling':
      return (
        <PurchasePolling
          purchaseId={step.purchaseId}
          onSuccess={() => setStep({ s: 'buy_success', credit: step.credit })}
          onError={msg => setStep({ s: 'error', msg })}
        />
      )
    case 'not_enabled':
      return (
        <NotEnabledConfirm
          pm={step.pm}
          onConfirm={enable}
          onCancel={() => cancel('not_enabled')}
        />
      )
    case 'enabled':
      return (
        <EnabledMenu
          usage={step.usage}
          balance={step.balance}
          currency={currency}
          onAction={action => handleAction(action, step)}
          onCancel={() => cancel('enabled')}
        />
      )
    case 'buy_select':
      return (
        <BuySelect
          pm={step.pm}
          presets={bundles}
          currency={currency}
          onConfirm={bundle =>
            setStep({
              s: 'buy_confirm',
              pm: step.pm,
              cents: bundle.local_price_minor_units,
              bundle,
            })
          }
          onCustom={() => setStep({ s: 'buy_custom', pm: step.pm })}
          onCancel={() => cancel('buy_select')}
        />
      )
    case 'buy_custom':
      return (
        <BuyCustom
          pm={step.pm}
          initialCents={step.initialCents}
          currency={currency}
          onConfirm={cents =>
            setStep({ s: 'buy_confirm', pm: step.pm, cents })
          }
          onCancel={() => setStep({ s: 'buy_select', pm: step.pm })}
        />
      )
    case 'buy_confirm':
      return (
        <BuyConfirm
          pm={step.pm}
          cents={step.cents}
          bundle={step.bundle}
          currency={currency}
          stripeProductId={stripeProductId}
          onConfirm={() => handleBuy(step.cents, step.bundle)}
          onCancel={() =>
            setStep(
              step.bundle
                ? { s: 'buy_select', pm: step.pm }
                : { s: 'buy_custom', pm: step.pm, initialCents: step.cents },
            )
          }
        />
      )
    case 'adjust_limit':
      return (
        <AdjustLimit
          current={step.current}
          currency={currency}
          onConfirm={cents => void handleAdjustLimit(cents, step.current)}
          onCancel={() => cancel('adjust_limit')}
        />
      )
    case 'auto_reload_config':
      return (
        <AutoReloadConfig
          current={step.current}
          pm={step.pm}
          currency={currency}
          onSave={(thresholdCents, reloadToCents) =>
            handleAutoReloadSave(true, thresholdCents, reloadToCents)
          }
          onTurnOff={() => handleAutoReloadSave(false, 0, 0)}
          onCancel={() => cancel('auto_reload_config')}
        />
      )
    case 'error':
      return <ErrorScreen msg={step.msg} onClose={() => cancel('error')} />
  }
}
