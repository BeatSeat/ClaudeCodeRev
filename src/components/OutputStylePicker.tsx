import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  getAllOutputStyles,
  OUTPUT_STYLE_CONFIG,
  type OutputStyleConfig,
} from '../constants/outputStyles.js'
import { Box, Text } from '../ink.js'
import type { OutputStyle } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import { isSafeMode } from '../utils/envUtils.js'
import { getSafeModeOffHint } from '../utils/safeModeHint.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/select.js'
import { Dialog } from './design-system/Dialog.js'

const DEFAULT_OUTPUT_STYLE_LABEL = 'Default'
const DEFAULT_OUTPUT_STYLE_DESCRIPTION =
  'Claude completes coding tasks efficiently and provides concise responses'

function mapConfigsToOptions(styles: {
  [styleName: string]: OutputStyleConfig | null
}): OptionWithDescription[] {
  return Object.entries(styles).map(([style, config]) => ({
    label: config?.name ?? DEFAULT_OUTPUT_STYLE_LABEL,
    value: style,
    description: config?.description ?? DEFAULT_OUTPUT_STYLE_DESCRIPTION,
  }))
}

export type OutputStylePickerProps = {
  initialStyle: OutputStyle
  onComplete: (style: OutputStyle) => void
  onCancel: () => void
  isStandaloneCommand?: boolean
}

export function OutputStylePicker({
  initialStyle,
  onComplete,
  onCancel,
  isStandaloneCommand,
}: OutputStylePickerProps): React.ReactNode {
  const [styleOptions, setStyleOptions] = useState<OptionWithDescription[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Load all output styles including custom ones
    getAllOutputStyles(getCwd())
      .then(allStyles => {
        const options = mapConfigsToOptions(allStyles)
        setStyleOptions(options)
        setIsLoading(false)
      })
      .catch(() => {
        // On error, fall back to built-in styles only
        const builtInOptions = mapConfigsToOptions(OUTPUT_STYLE_CONFIG)
        setStyleOptions(builtInOptions)
        setIsLoading(false)
      })
  }, [])

  const handleStyleSelect = useCallback(
    (style: string) => {
      const outputStyle = style as OutputStyle
      onComplete(outputStyle)
    },
    [onComplete],
  )

  // Official 2.1.169 safe mode (bundle `id4`): the saved style isn't among the
  // loaded options — it's a custom style that safe mode keeps unloaded.
  // Bundle `K1("outputStyles")` ≡ safe mode for output styles.
  const savedCustomStyleDisabled =
    !isLoading &&
    isSafeMode() &&
    !styleOptions.some(option => option.value === initialStyle)

  return (
    <Dialog
      title="Preferred output style"
      onCancel={onCancel}
      hideInputGuide={!isStandaloneCommand}
      hideBorder={!isStandaloneCommand}
    >
      <Box flexDirection="column" gap={1}>
        <Box marginTop={1}>
          <Text dimColor>
            This changes how Claude Code communicates with you
          </Text>
        </Box>
        {savedCustomStyleDisabled && (
          <Text dimColor>
            {`Your saved output style "${initialStyle}" is a custom style disabled in safe mode — ${getSafeModeOffHint()} to use it; selecting a style here replaces it`}
          </Text>
        )}
        {isLoading ? (
          <Text dimColor>Loading output styles…</Text>
        ) : (
          <Select
            options={styleOptions}
            onChange={handleStyleSelect}
            visibleOptionCount={10}
            defaultValue={initialStyle}
          />
        )}
      </Box>
    </Dialog>
  )
}
