import { useEffect, useMemo, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  isExemptDefaultResolvingPick,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  isModelAllowed,
  isModelAllowedUnderActiveEnforcement,
} from '../utils/model/modelAllowlist.js'

function useGrowthBookRefreshTick(): number {
  const [tick, forceRerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])
  return tick
}

export function resolveEffectiveMainLoopModelSetting(
  sessionModel?: string | null,
  mainLoopModel?: string | null,
): string {
  for (const model of [sessionModel, mainLoopModel]) {
    if (model == null) continue
    if (
      isExemptDefaultResolvingPick(model) ||
      (isModelAllowedUnderActiveEnforcement(model) ?? isModelAllowed(model))
    ) {
      return model
    }
  }
  return getDefaultMainLoopModelSetting()
}

export function useEffectiveMainLoopModelSetting(): string {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const refreshTick = useGrowthBookRefreshTick()
  const settings = useAppState(s => s.settings)

  return useMemo(() => {
    return resolveEffectiveMainLoopModelSetting(
      mainLoopModelForSession,
      mainLoopModel,
    )
  }, [mainLoopModelForSession, mainLoopModel, refreshTick, settings])
}

// The value of the selector is a full model name that can be used directly in
// API calls. Use this over getMainLoopModel() when the component needs to
// update upon a model config change.
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const refreshTick = useGrowthBookRefreshTick()
  const settings = useAppState(s => s.settings)

  return useMemo(() => {
    return parseUserSpecifiedModel(
      resolveEffectiveMainLoopModelSetting(
        mainLoopModelForSession,
        mainLoopModel,
      ),
    )
  }, [mainLoopModelForSession, mainLoopModel, refreshTick, settings])
}

