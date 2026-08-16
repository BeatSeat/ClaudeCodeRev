import React, { useRef, useState } from 'react'
import { WizardProvider } from '../wizard/index.js'
import type { WizardStepComponent } from '../wizard/types.js'
import type { BedrockWizardData } from './types.js'
import {
  AccessKeyIdStep,
  SecretKeyStep,
  SessionTokenStep,
} from './steps/AccessKeySteps.js'
import { AuthMethodStep } from './steps/AuthMethodStep.js'
import { BearerStep } from './steps/BearerStep.js'
import { ConfirmStep } from './steps/ConfirmStep.js'
import { PinModelsStep } from './steps/PinModelsStep.js'
import { ProfileStep } from './steps/ProfileStep.js'
import { RegionStep } from './steps/RegionStep.js'
import { VerifyStep } from './steps/VerifyStep.js'

type Props = {
  onComplete: (message: string) => void
  onCancel: () => void
}

export function BedrockSetupWizard({
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const [steps] = useState<WizardStepComponent<BedrockWizardData>[]>(() => [
    AuthMethodStep,
    ProfileStep,
    BearerStep,
    AccessKeyIdStep,
    SecretKeyStep,
    SessionTokenStep,
    RegionStep,
    VerifyStep,
    PinModelsStep,
    () => (
      <ConfirmStep onComplete={message => onCompleteRef.current(message)} />
    ),
  ])

  return (
    <WizardProvider<BedrockWizardData>
      steps={steps}
      initialData={{}}
      onComplete={() => {}}
      onCancel={onCancel}
      title="Set up AWS Bedrock"
      showStepCounter={false}
    />
  )
}
