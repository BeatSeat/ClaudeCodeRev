import * as React from 'react'
import { useMemo } from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text } from '../../ink.js'
import {
  getModelPinSourceAnnotation,
  getPublicModelDisplayName,
} from '../../utils/model/model.js'

/**
 * Startup header when the active model comes from a project or managed pin.
 * Official 2.1.117 o88 — hidden when annotation is empty.
 */
export function ModelPinHeader(): React.ReactNode {
  const model = useMainLoopModel()
  const annotation = useMemo(() => getModelPinSourceAnnotation(), [model])
  if (!annotation) {
    return null
  }
  const display = getPublicModelDisplayName(model) ?? model
  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        Using {display}
        {annotation} · /model to change
      </Text>
    </Box>
  )
}
