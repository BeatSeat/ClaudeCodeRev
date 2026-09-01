import React, { useEffect, useMemo, useState } from 'react'
import { count } from '../../../utils/array.js'
import { Box, Text } from '../../../ink.js'
import { plural } from '../../../utils/stringUtils.js'
import { Select } from '../../CustomSelect/select.js'
import { StatusIcon } from '../../design-system/StatusIcon.js'
import { Spinner } from '../../Spinner.js'
import { useWizard } from '../../wizard/index.js'
import { WizardDialogLayout } from '../../wizard/WizardDialogLayout.js'
import { modelSupports1M } from '../../../utils/context.js'
import {
  existingPinFromEnv,
  getDefaultModelCandidates,
  pickDefaultPinnedId,
  PIN_TIERS,
  probeModel,
  PROBE_REASON_LABELS,
  TIER_LABELS,
  with1mSuffix,
} from '../helpers.js'
import type {
  BedrockWizardData,
  ModelTier,
  ProbeState,
} from '../types.js'

type View = 'summary' | { picking: ModelTier }

export function PinModelsStep(): React.ReactNode {
  const { goBack, goNext, updateWizardData, wizardData } =
    useWizard<BedrockWizardData>()
  const profiles = wizardData.discoveredProfiles ?? []
  const defaults = useMemo(
    () => getDefaultModelCandidates(wizardData.region),
    [wizardData.region],
  )
  const existingPins = useMemo(
    () =>
      Object.fromEntries(
        PIN_TIERS.map(tier => [tier, existingPinFromEnv(tier)]),
      ) as Record<ModelTier, string | undefined>,
    [],
  )
  const initialIds = () => ({
    sonnet:
      existingPins.sonnet ?? pickDefaultPinnedId(profiles, defaults.sonnet),
    opus: existingPins.opus ?? pickDefaultPinnedId(profiles, defaults.opus),
    haiku: existingPins.haiku ?? pickDefaultPinnedId(profiles, defaults.haiku),
  })
  const [ids, setIds] = useState(initialIds)
  const [states, setStates] = useState<Record<ModelTier, ProbeState>>({
    sonnet: 'pending',
    opus: 'pending',
    haiku: 'pending',
  })
  const [view, setView] = useState<View>('summary')

  useEffect(() => {
    let cancelled = false
    setStates(prev => ({ ...prev, sonnet: 'pending' }))
    void probeModel(wizardData, ids.sonnet).then(result => {
      if (!cancelled) {
        setStates(prev => ({ ...prev, sonnet: result }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [ids.sonnet])

  useEffect(() => {
    let cancelled = false
    setStates(prev => ({ ...prev, opus: 'pending' }))
    void probeModel(wizardData, ids.opus).then(result => {
      if (!cancelled) {
        setStates(prev => ({ ...prev, opus: result }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [ids.opus])

  useEffect(() => {
    let cancelled = false
    setStates(prev => ({ ...prev, haiku: 'pending' }))
    void probeModel(wizardData, ids.haiku).then(result => {
      if (!cancelled) {
        setStates(prev => ({ ...prev, haiku: result }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [ids.haiku])

  if (view !== 'summary') {
    const tier = view.picking
    return (
      <PinModelPicker
        tier={tier}
        wizardData={wizardData}
        profiles={profiles}
        fallback={defaults[tier].fallback}
        current={ids[tier]}
        existingPin={existingPins[tier]}
        onPick={modelId => {
          setIds(prev => ({ ...prev, [tier]: modelId }))
          const index = PIN_TIERS.indexOf(tier)
          const next = PIN_TIERS[index + 1]
          setView(next ? { picking: next } : 'summary')
        }}
        onCancel={() => setView('summary')}
      />
    )
  }

  const canPin =
    PIN_TIERS.every(tier => states[tier] !== 'pending') &&
    PIN_TIERS.some(tier => states[tier] !== 'pending' && states[tier].ok)
  const canPin1m =
    canPin &&
    PIN_TIERS.some(tier => {
      const state = states[tier]
      return state !== 'pending' && state.ok && modelSupports1M(ids[tier])
    })

  return (
    <WizardDialogLayout subtitle="Pin model versions">
      <Box flexDirection="column" gap={1}>
        <Text>
          Without pinning, Claude Code uses its built-in defaults. When a new
          model ships, your install will try to call it even if your account has
          not yet enabled it — Claude Code will fail to connect to Bedrock until
          you enable the model or pin to one you have.
        </Text>
        <Box flexDirection="column">
          <Text dimColor>
            Each candidate is tested with a one-token request:
          </Text>
          {PIN_TIERS.map(tier => (
            <PinProbeRow
              key={tier}
              label={TIER_LABELS[tier]}
              modelId={ids[tier]}
              state={states[tier]}
            />
          ))}
        </Box>
        <Select
          options={[
            ...(canPin
              ? [{ label: 'Pin the working models', value: 'pin' }]
              : []),
            ...(canPin1m
              ? [
                  {
                    label: 'Pin the working models with 1M context',
                    value: 'pin1m',
                  },
                ]
              : []),
            { label: 'Choose different models…', value: 'manual' },
            {
              label: 'Skip — use Claude Code defaults (auto-updates)',
              value: 'skip',
            },
          ]}
          onChange={value => {
            if (value === 'manual') {
              setView({ picking: 'sonnet' })
              return
            }
            if (value === 'pin' || value === 'pin1m') {
              const pick = (tier: ModelTier) => {
                const state = states[tier]
                if (state === 'pending' || !state.ok) return
                const id = ids[tier]
                return value === 'pin1m' && modelSupports1M(id)
                  ? with1mSuffix(id)
                  : id
              }
              updateWizardData({
                pinSonnet: pick('sonnet'),
                pinOpus: pick('opus'),
                pinHaiku: pick('haiku'),
              })
            } else {
              updateWizardData({
                pinSonnet: undefined,
                pinOpus: undefined,
                pinHaiku: undefined,
              })
            }
            goNext()
          }}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}

function PinModelPicker({
  tier,
  wizardData,
  profiles,
  fallback,
  current,
  existingPin,
  onPick,
  onCancel,
}: {
  tier: ModelTier
  wizardData: BedrockWizardData
  profiles: string[]
  fallback: string
  current: string
  existingPin?: string
  onPick: (modelId: string) => void
  onCancel: () => void
}): React.ReactNode {
  const candidates = useMemo(() => {
    const list = [
      ...profiles
        .filter(id => id.toLowerCase().includes(tier))
        .sort()
        .reverse(),
    ]
    for (const extra of [fallback, current, existingPin]) {
      if (extra && !list.includes(extra)) {
        list.push(extra)
      }
    }
    return list
  }, [profiles, tier, fallback, current, existingPin])

  const [probeById, setProbeById] = useState<Record<string, ProbeState>>(() =>
    Object.fromEntries(candidates.map(id => [id, 'pending'])),
  )

  useEffect(() => {
    let cancelled = false
    for (const id of candidates) {
      void probeModel(wizardData, id).then(result => {
        if (!cancelled) {
          setProbeById(prev => ({ ...prev, [id]: result }))
        }
      })
    }
    return () => {
      cancelled = true
    }
    // Official Knz probes the initial candidate list once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const settled = candidates.every(id => probeById[id] !== 'pending')
  const isOk = (id: string) => {
    const state = probeById[id]
    return state !== undefined && state !== 'pending' && state.ok
  }
  const ordered = useMemo(() => {
    if (!settled) {
      return candidates
    }
    return [...candidates].sort((a, b) => (isOk(a) ? 0 : 1) - (isOk(b) ? 0 : 1))
  }, [candidates, probeById, settled])

  const matching = count(profiles, id => id.toLowerCase().includes(tier))

  return (
    <WizardDialogLayout subtitle={`Pin ${TIER_LABELS[tier]} model`}>
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {matching > 0
            ? `${matching} ${TIER_LABELS[tier]} ${plural(matching, 'profile')} in your account · each tested with a one-token request.`
            : `No ${TIER_LABELS[tier]} profiles found in your account.`}
        </Text>
        <Select
          key={settled ? 'settled' : 'pending'}
          options={ordered.map(id => ({
            value: id,
            label: (
              <PinCandidateLabel
                id={id}
                state={probeById[id] ?? 'pending'}
                suffix={
                  id === fallback
                    ? '(built-in default)'
                    : id === current
                      ? '(current)'
                      : undefined
                }
              />
            ),
          }))}
          defaultValue={settled ? ordered.find(isOk) : current}
          onChange={onPick}
          onCancel={onCancel}
        />
      </Box>
    </WizardDialogLayout>
  )
}

function PinCandidateLabel({
  id,
  state,
  suffix,
}: {
  id: string
  state: ProbeState
  suffix?: string
}): React.ReactNode {
  if (state === 'pending') {
    return (
      <Text>
        <StatusIcon status="pending" withSpace />
        {id}
        {suffix ? <Text dimColor> {suffix}</Text> : null}
      </Text>
    )
  }
  if (state.ok) {
    return (
      <Text>
        <StatusIcon status="success" withSpace />
        {id}
        {suffix ? <Text dimColor> {suffix}</Text> : null}
      </Text>
    )
  }
  return (
    <Text dimColor>
      <StatusIcon status="error" withSpace />
      {id}
      {suffix ? ` ${suffix}` : ''}{' '}
      <Text color="error">
        ({PROBE_REASON_LABELS[state.ok === false ? state.reason : 'other']})
      </Text>
    </Text>
  )
}

function PinProbeRow({
  label,
  modelId,
  state,
}: {
  label: string
  modelId: string
  state: ProbeState
}): React.ReactNode {
  const padded = label.padEnd(7)
  if (state === 'pending') {
    return (
      <Box>
        <Text>  </Text>
        <Spinner />
        <Text>
          {' '}
          {padded}→ {modelId}
        </Text>
      </Box>
    )
  }
  if (state.ok) {
    return (
      <Text>
        {'  '}
        <StatusIcon status="success" withSpace />
        {padded}→ <Text color="success">{modelId}</Text>
      </Text>
    )
  }
  return (
    <Text>
      {'  '}
      <StatusIcon status="error" withSpace />
      {padded}→ <Text dimColor>{modelId}</Text>{' '}
      <Text color="error">
        ({PROBE_REASON_LABELS[state.ok === false ? state.reason : 'other']})
      </Text>
    </Text>
  )
}
