export const VERTEX_SETUP_STEPS = {
  AUTH_METHOD: 0,
  SERVICE_ACCOUNT: 1,
  PROJECT: 2,
  REGION: 3,
  VERIFY: 4,
  PIN_MODELS: 5,
  CONFIRM: 6,
} as const

export type VertexAuthMethod = 'adc' | 'serviceAccount' | 'environment'

export type VertexWizardData = {
  authMethod?: VertexAuthMethod
  projectId?: string
  region?: string
  keyFile?: string
  verifiedIdentity?: string
  pinSonnet?: string
  pinOpus?: string
  pinHaiku?: string
}

export type ModelTier = 'sonnet' | 'opus' | 'haiku'

export type ProbeReason =
  | 'auth'
  | 'permission'
  | 'model'
  | 'network'
  | 'other'

export type ProbeState = 'pending' | { ok: true } | { ok: false; reason: ProbeReason }

export type VerifyResult =
  | {
      status: 'ok'
      identity: string
      note?: string
    }
  | {
      status: 'error'
      error: string
      command?: string
    }
