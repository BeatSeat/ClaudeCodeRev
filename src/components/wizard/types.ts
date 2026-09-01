import type { Dispatch, ReactNode, SetStateAction } from 'react'

export type WizardStepComponent<T = unknown> = React.ComponentType<{
  data?: T
  onNext?: (data: Partial<T>) => void
  onBack?: () => void
}>

export type WizardContextValue<T = Record<string, unknown>> = {
  currentStepIndex: number
  totalSteps: number
  wizardData: T
  setWizardData: Dispatch<SetStateAction<T>>
  updateWizardData: (data: Partial<T>) => void
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  cancel: () => void
  title?: string
  showStepCounter?: boolean
}

export type WizardProviderProps<T extends Record<string, unknown> = Record<string, unknown>> = {
  steps: WizardStepComponent<T>[]
  initialData?: T
  onComplete: (data: T) => void
  onCancel?: () => void
  children?: ReactNode
  title?: string
  showStepCounter?: boolean
}
