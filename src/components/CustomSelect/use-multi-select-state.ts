import { useCallback, useState } from 'react'
import { isDeepStrictEqual } from 'util'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import {
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
} from '../../utils/stringUtils.js'
import type { OptionWithDescription } from './select.js'
import { useSelectNavigation } from './use-select-navigation.js'

export type UseMultiSelectStateProps<T> = {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  isDisabled?: boolean

  /**
   * Number of items to display.
   *
   * @default 5
   */
  visibleOptionCount?: number

  /**
   * Options.
   */
  options: OptionWithDescription<T>[]

  /**
   * Initially selected values.
   */
  defaultValue?: T[]

  /**
   * Callback when selection changes.
   */
  onChange?: (values: T[]) => void

  /**
   * Callback for canceling the select.
   */
  onCancel: () => void

  /**
   * Callback for focusing an option.
   */
  onFocus?: (value: T) => void

  /**
   * Value to focus
   */
  focusValue?: T

  /**
   * Text for the submit button. When provided, a submit button is shown and
   * Enter toggles selection (submit only fires when the button is focused).
   * When omitted, Enter submits directly and Space toggles selection.
   */
  submitButtonText?: string

  /**
   * Callback when user submits. Receives the currently selected values.
   */
  onSubmit?: (values: T[]) => void

  /**
   * Callback when user presses down from the last item (submit button).
   * If provided, navigation will not wrap to the first item.
   */
  onDownFromLastItem?: () => void

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  onUpFromFirstItem?: () => void

  /**
   * Focus the last option initially instead of the first.
   */
  initialFocusLast?: boolean

  /**
   * When true, numeric keys (1-9) do not toggle options by index.
   * Mirrors the rendering layer's hideIndexes: if index labels aren't shown,
   * pressing a number shouldn't silently toggle an invisible mapping.
   */
  hideIndexes?: boolean
}

export type MultiSelectState<T> = {
  /**
   * Value of the currently focused option.
   */
  focusedValue: T | undefined

  /**
   * Index of the first visible option.
   */
  visibleFromIndex: number

  /**
   * Index of the last visible option.
   */
  visibleToIndex: number

  /**
   * All options.
   */
  options: OptionWithDescription<T>[]

  /**
   * Visible options.
   */
  visibleOptions: Array<OptionWithDescription<T> & { index: number }>

  /**
   * Whether the focused option is an input type.
   */
  isInInput: boolean

  /**
   * Currently selected values.
   */
  selectedValues: T[]

  /**
   * Current input field values.
   */
  inputValues: Map<T, string>

  /**
   * Whether the submit button is focused.
   */
  isSubmitFocused: boolean

  /**
   * Update an input field value.
   */
  updateInputValue: (value: T, inputValue: string) => void

  /**
   * Callback for canceling the select.
   */
  onCancel: () => void

  /**
   * Process keyboard input dispatched to the focused select container.
   */
  handleKeyDown: (event: KeyboardEvent) => void
}

export function useMultiSelectState<T>({
  isDisabled = false,
  visibleOptionCount = 5,
  options,
  defaultValue = [],
  onChange,
  onCancel,
  onFocus,
  focusValue,
  submitButtonText,
  onSubmit,
  onDownFromLastItem,
  onUpFromFirstItem,
  initialFocusLast,
  hideIndexes = false,
}: UseMultiSelectStateProps<T>): MultiSelectState<T> {
  const [selectedValues, setSelectedValues] = useState<T[]>(defaultValue)
  const [isSubmitFocused, setIsSubmitFocused] = useState(false)

  // Reset selectedValues when options change (e.g. async-loaded data changes
  // defaultValue after mount). Mirrors the reset pattern in use-select-navigation.ts
  // and the deleted ui/useMultiSelectState.ts — without this, MCPServerDesktopImportDialog
  // keeps colliding servers checked after getAllMcpConfigs() resolves.
  const [lastOptions, setLastOptions] = useState(options)
  if (options !== lastOptions && !isDeepStrictEqual(options, lastOptions)) {
    setSelectedValues(defaultValue)
    setLastOptions(options)
  }

  // State for input type options
  const [inputValues, setInputValues] = useState<Map<T, string>>(() => {
    const initialMap = new Map<T, string>()
    options.forEach(option => {
      if (option.type === 'input' && option.initialValue) {
        initialMap.set(option.value, option.initialValue)
      }
    })
    return initialMap
  })

  const updateSelectedValues = useCallback(
    (values: T[] | ((prev: T[]) => T[])) => {
      const newValues =
        typeof values === 'function' ? values(selectedValues) : values
      setSelectedValues(newValues)
      onChange?.(newValues)
    },
    [selectedValues, onChange],
  )

  const navigation = useSelectNavigation<T>({
    visibleOptionCount,
    options,
    initialFocusValue: initialFocusLast
      ? options[options.length - 1]?.value
      : undefined,
    onFocus,
    focusValue,
  })

  // Automatically register as an overlay.
  // This ensures CancelRequestHandler won't intercept Escape when the multi-select is active.
  useRegisterOverlay('multi-select')

  const updateInputValue = useCallback(
    (value: T, inputValue: string) => {
      setInputValues(prev => {
        const next = new Map(prev)
        next.set(value, inputValue)
        return next
      })

      // Find the option and call its onChange
      const option = options.find(opt => opt.value === value)
      if (option && option.type === 'input') {
        option.onChange(inputValue)
      }

      // Update selected values to include/exclude based on input
      updateSelectedValues(prev => {
        if (inputValue) {
          if (!prev.includes(value)) {
            return [...prev, value]
          }
          return prev
        } else {
          return prev.filter(v => v !== value)
        }
      })
    },
    [options, updateSelectedValues],
  )

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (isDisabled) return

    const normalizedInput = normalizeFullWidthDigits(event.key)
    const focusedOption = options.find(
      option => option.value === navigation.focusedValue,
    )
    const isInInput = focusedOption?.type === 'input'

    // Input options own text editing; the container only handles navigation.
    if (isInInput) {
      const isAllowedKey =
        event.key === 'up' ||
        event.key === 'down' ||
        event.key === 'escape' ||
        event.key === 'tab' ||
        event.key === 'return' ||
        (event.ctrl &&
          (event.key === 'n' ||
            event.key === 'p' ||
            event.key === 'return'))
      if (!isAllowedKey) return
    }

    const lastOptionValue = options[options.length - 1]?.value

    if (event.key === 'tab' && !event.shift) {
      event.preventDefault()
      if (
        submitButtonText &&
        onSubmit &&
        navigation.focusedValue === lastOptionValue &&
        !isSubmitFocused
      ) {
        setIsSubmitFocused(true)
      } else if (!isSubmitFocused) {
        navigation.focusNextOption()
      }
      return
    }

    if (event.key === 'tab' && event.shift) {
      event.preventDefault()
      if (submitButtonText && onSubmit && isSubmitFocused) {
        setIsSubmitFocused(false)
        navigation.focusOption(lastOptionValue)
      } else {
        navigation.focusPreviousOption()
      }
      return
    }

    if (
      event.key === 'down' ||
      (event.ctrl && event.key === 'n') ||
      (!event.ctrl && !event.shift && event.key === 'j')
    ) {
      event.preventDefault()
      if (isSubmitFocused && onDownFromLastItem) {
        onDownFromLastItem()
      } else if (
        submitButtonText &&
        onSubmit &&
        navigation.focusedValue === lastOptionValue &&
        !isSubmitFocused
      ) {
        setIsSubmitFocused(true)
      } else if (
        !submitButtonText &&
        onDownFromLastItem &&
        navigation.focusedValue === lastOptionValue
      ) {
        onDownFromLastItem()
      } else if (!isSubmitFocused) {
        navigation.focusNextOption()
      }
      return
    }

    if (
      event.key === 'up' ||
      (event.ctrl && event.key === 'p') ||
      (!event.ctrl && !event.shift && event.key === 'k')
    ) {
      event.preventDefault()
      if (submitButtonText && onSubmit && isSubmitFocused) {
        setIsSubmitFocused(false)
        navigation.focusOption(lastOptionValue)
      } else if (
        onUpFromFirstItem &&
        navigation.focusedValue === options[0]?.value
      ) {
        onUpFromFirstItem()
      } else {
        navigation.focusPreviousOption()
      }
      return
    }

    if (event.key === 'pagedown') {
      event.preventDefault()
      navigation.focusNextPage()
      return
    }

    if (event.key === 'pageup') {
      event.preventDefault()
      navigation.focusPreviousPage()
      return
    }

    if (
      event.key === 'return' ||
      normalizeFullWidthSpace(event.key) === ' '
    ) {
      event.preventDefault()
      if (event.ctrl && event.key === 'return' && isInInput && onSubmit) {
        onSubmit(selectedValues)
        return
      }
      if (isSubmitFocused && onSubmit) {
        onSubmit(selectedValues)
        return
      }
      if (event.key === 'return' && !submitButtonText && onSubmit) {
        onSubmit(selectedValues)
        return
      }
      if (navigation.focusedValue !== undefined) {
        const newValues = selectedValues.includes(navigation.focusedValue)
          ? selectedValues.filter(value => value !== navigation.focusedValue)
          : [...selectedValues, navigation.focusedValue]
        updateSelectedValues(newValues)
      }
      return
    }

    if (!hideIndexes && /^[0-9]$/.test(normalizedInput)) {
      event.preventDefault()
      const optionIndex = parseInt(normalizedInput) - 1
      if (optionIndex >= 0 && optionIndex < options.length) {
        const optionValue = options[optionIndex]!.value
        const newValues = selectedValues.includes(optionValue)
          ? selectedValues.filter(value => value !== optionValue)
          : [...selectedValues, optionValue]
        updateSelectedValues(newValues)
      }
      return
    }

    if (event.key === 'escape') {
      onCancel()
      event.stopImmediatePropagation()
    }
  }

  return {
    ...navigation,
    selectedValues,
    inputValues,
    isSubmitFocused,
    updateInputValue,
    onCancel,
    handleKeyDown,
  }
}
