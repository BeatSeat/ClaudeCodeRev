export const BEDROCK_SETUP_STEPS = {
  AUTH_METHOD: 0,
  PROFILE: 1,
  BEARER: 2,
  ACCESS_KEY_ID: 3,
  SECRET_KEY: 4,
  SESSION_TOKEN: 5,
  REGION: 6,
  VERIFY: 7,
  PIN_MODELS: 8,
  CONFIRM: 9,
} as const

export type BedrockAuthMethod =
  | 'profile'
  | 'bearer'
  | 'accessKey'
  | 'environment'

export type BedrockWizardData = {
  authMethod?: BedrockAuthMethod
  awsProfile?: string
  bearerToken?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  region?: string
  verifiedIdentity?: string
  discoveredProfiles?: string[]
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
      profiles: string[]
      note?: string
    }
  | {
      status: 'error'
      error: string
      command?: string
    }
