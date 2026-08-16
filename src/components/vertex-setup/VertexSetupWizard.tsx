import React, { useRef, useState } from 'react'
import { WizardProvider } from '../wizard/index.js'
import type { WizardStepComponent } from '../wizard/types.js'
import type { VertexWizardData } from './types.js'
import { AuthMethodStep } from './steps/AuthMethodStep.js'
import { ConfirmStep } from './steps/ConfirmStep.js'
import { PinModelsStep } from './steps/PinModelsStep.js'
import { ProjectStep } from './steps/ProjectStep.js'
import { RegionStep } from './steps/RegionStep.js'
import { ServiceAccountStep } from './steps/ServiceAccountStep.js'
import { VerifyStep } from './steps/VerifyStep.js'

type Props = {
  onComplete: (message: string) => void
  onCancel: () => void
}

export function VertexSetupWizard({
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const [steps] = useState<WizardStepComponent<VertexWizardData>[]>(() => [
    AuthMethodStep,
    ServiceAccountStep,
    ProjectStep,
    RegionStep,
    VerifyStep,
    PinModelsStep,
    () => (
      <ConfirmStep onComplete={message => onCompleteRef.current(message)} />
    ),
  ])

  return (
    <WizardProvider<VertexWizardData>
      steps={steps}
      initialData={{}}
      onComplete={() => {}}
      onCancel={onCancel}
      title="Set up Google Vertex AI"
      showStepCounter={false}
    />
  )
}
