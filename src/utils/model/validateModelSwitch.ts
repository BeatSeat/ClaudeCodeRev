/**
 * Official 2.1.187 `I9t` — hard model-switch validation (/model, inline set).
 *
 * Soft redirect paths keep `formatModelRestrictedWarning` ("Using X instead").
 * This module returns the deny messages used when a switch is rejected outright.
 */

import { featureBad } from '../../components/FleetView/fleetTelemetry.js'
import { errorMessage } from '../errors.js'
import { isModelDeniedByEntitlement } from './modelAccessEntitlement.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from './check1mAccess.js'
import { isOpus1mMergeEnabled } from './model.js'
import { MODEL_ALIASES } from './aliases.js'
import { validateModel } from './validateModel.js'

export type ModelSwitchResult =
  | { ok: true; model: string | null }
  | { ok: false; message: string }

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(
    model.toLowerCase().trim(),
  )
}

function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkOpus1mAccess() &&
    !isOpus1mMergeEnabled() &&
    m.includes('opus') &&
    m.includes('[1m]')
  )
}

function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkSonnet1mAccess() &&
    (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'))
  )
}

/**
 * Official 2.1.187 `I9t`.
 * `args === 'default'` clears the session model (null).
 */
export async function validateModelSwitch(
  args: string,
): Promise<ModelSwitchResult> {
  const model = args === 'default' ? null : args

  if (model && isModelDeniedByEntitlement(model)) {
    featureBad('model_switch', 'denied_by_entitlement')
    return {
      ok: false,
      message: `Model '${model}' is restricted by your organization's settings. Run /model to choose a different model.`,
    }
  }

  if (model && !isModelAllowed(model)) {
    featureBad('model_switch', 'not_allowed')
    return {
      ok: false,
      message: `Model '${model}' is not available. Your organization restricts model selection.`,
    }
  }

  if (model && isOpus1mUnavailable(model)) {
    featureBad('model_switch', 'opus_1m_unavailable')
    return {
      ok: false,
      message:
        'Opus with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
    }
  }

  if (model && isSonnet1mUnavailable(model)) {
    featureBad('model_switch', 'sonnet_1m_unavailable')
    return {
      ok: false,
      message:
        'Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
    }
  }

  if (!model || isKnownAlias(model)) {
    return { ok: true, model }
  }

  try {
    const result = await validateModel(model)
    if (!result.valid) {
      featureBad('model_switch', 'invalid_model')
      return { ok: false, message: result.error ?? `Model '${model}' not found` }
    }
    return { ok: true, model }
  } catch (err) {
    featureBad('model_switch', 'validate_exception')
    return {
      ok: false,
      message: `Failed to validate model: ${errorMessage(err)}`,
    }
  }
}
