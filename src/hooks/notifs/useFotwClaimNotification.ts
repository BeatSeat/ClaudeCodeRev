import { useEffect } from 'react'
import type { Notification } from '../../context/notifications.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  FOTW_CLAIM_NOTIFICATION_KEY,
  FOTW_GRANTED_FAILED_TIMEOUT_MS,
  FOTW_PENDING_TIMEOUT_MS,
  formatCreditAmountPrecise,
  refreshFotwEligibility,
} from '../../services/api/fotwClaim.js'

type AddNotificationFn = (content: Notification) => void
type RemoveNotificationFn = (key: string) => void

/**
 * Official 2.1.157 `yA9(addNotification, removeNotification)`.
 * FotW credit-claim toast (not the 156 `e_9` inline banner).
 */
export function useFotwClaimNotification(
  addNotification: AddNotificationFn,
  removeNotification: RemoveNotificationFn,
): void {
  const fotwClaim = useAppState(s => s.fotwClaim)
  const setAppState = useSetAppState()

  useEffect(() => {
    void refreshFotwEligibility()
  }, [])

  const phase = fotwClaim?.phase
  useEffect(() => {
    if (phase === undefined || phase === 'pending') return
    const timer = setTimeout(() => {
      setAppState(prev =>
        prev.fotwClaim ? { ...prev, fotwClaim: undefined } : prev,
      )
    }, FOTW_GRANTED_FAILED_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [phase, setAppState])

  useEffect(() => {
    if (!fotwClaim) {
      removeNotification(FOTW_CLAIM_NOTIFICATION_KEY)
      return
    }
    const amount = formatCreditAmountPrecise(
      fotwClaim.amountMinorUnits,
      fotwClaim.currency,
    )
    removeNotification(FOTW_CLAIM_NOTIFICATION_KEY)
    switch (fotwClaim.phase) {
      case 'pending':
        addNotification({
          key: FOTW_CLAIM_NOTIFICATION_KEY,
          text: `Thanks for trying the feature of the week. ${amount} in usage credits on its way!`,
          priority: 'medium',
          timeoutMs: FOTW_PENDING_TIMEOUT_MS,
        })
        return
      case 'granted':
        addNotification({
          key: FOTW_CLAIM_NOTIFICATION_KEY,
          text: `${amount} in usage credits added to your account · Used before any purchased credits · expires in 90 days`,
          color: 'success',
          priority: 'medium',
          timeoutMs: FOTW_GRANTED_FAILED_TIMEOUT_MS,
        })
        return
      case 'failed':
        addNotification({
          key: FOTW_CLAIM_NOTIFICATION_KEY,
          text: 'Something went wrong when adding your usage credits. Contact support for help.',
          color: 'error',
          priority: 'medium',
          timeoutMs: FOTW_GRANTED_FAILED_TIMEOUT_MS,
        })
        return
      case 'needs_payment_setup':
        addNotification({
          key: FOTW_CLAIM_NOTIFICATION_KEY,
          text: `To claim ${amount} in usage credits, add a payment method at https://claude.ai/settings/billing, then run /${fotwClaim.command} again to claim (claiming turns on extra usage billing)`,
          priority: 'immediate',
          requeueOnPreempt: true,
          timeoutMs: FOTW_GRANTED_FAILED_TIMEOUT_MS,
        })
        return
    }
  }, [fotwClaim, addNotification, removeNotification])
}
