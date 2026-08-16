import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { ALL_MODEL_CONFIGS } from '../../utils/model/configs.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type {
  ProbeReason,
  ProbeState,
  VerifyResult,
  VertexAuthMethod,
  VertexWizardData,
} from './types.js'

export const PIN_TIERS = ['sonnet', 'opus', 'haiku'] as const

export const TIER_LABELS = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
} as const

export const PROBE_REASON_LABELS: Record<ProbeReason, string> = {
  auth: 'auth failed',
  permission: 'no aiplatform.endpoints.predict permission',
  model: 'not enabled in this project',
  network: 'unreachable',
  other: 'request failed',
}

const DEFAULT_MODEL_KEYS = {
  sonnet: 'sonnet45',
  opus: 'opus46',
  haiku: 'haiku45',
} as const

const GCP_CREDENTIALS_TIMEOUT_MS = 12_000
const ADC_LOGIN_COMMAND = 'gcloud auth application-default login'
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

type ClientAuth =
  | { kind: 'keyFile'; path: string }
  | { kind: 'default' }
  | { kind: 'skip' }

export function getDefaultVertexModels(): Record<
  'sonnet' | 'opus' | 'haiku',
  string
> {
  return {
    sonnet: ALL_MODEL_CONFIGS[DEFAULT_MODEL_KEYS.sonnet].vertex,
    opus: ALL_MODEL_CONFIGS[DEFAULT_MODEL_KEYS.opus].vertex,
    haiku: ALL_MODEL_CONFIGS[DEFAULT_MODEL_KEYS.haiku].vertex,
  }
}

export function listVertexModelsForTier(tier: string): string[] {
  const ids = new Set<string>()
  for (const config of Object.values(ALL_MODEL_CONFIGS)) {
    if (config.vertex.toLowerCase().includes(tier)) {
      ids.add(config.vertex)
    }
  }
  return [...ids].sort().reverse()
}

export function buildVertexEnv(
  data: VertexWizardData,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
    ANTHROPIC_VERTEX_PROJECT_ID: data.projectId,
    CLOUD_ML_REGION: data.region,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
    ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
    ANTHROPIC_SMALL_FAST_MODEL: undefined,
  }
  if (data.authMethod === 'serviceAccount') {
    env.GOOGLE_APPLICATION_CREDENTIALS = data.keyFile
  }
  if (data.pinSonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = data.pinSonnet
  }
  if (data.pinOpus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = data.pinOpus
  }
  if (data.pinHaiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = data.pinHaiku
  }
  return env
}

function resolveWizardAuth(data: VertexWizardData): ClientAuth {
  if (data.authMethod === 'serviceAccount' && data.keyFile) {
    return { kind: 'keyFile', path: data.keyFile }
  }
  return { kind: 'default' }
}

async function buildVertexGoogleAuth(
  auth: ClientAuth,
  projectId?: string,
) {
  if (auth.kind === 'skip') {
    return {
      getClient: () => ({
        getRequestHeaders: () => ({}),
      }),
    } as unknown as InstanceType<
      typeof import('google-auth-library').GoogleAuth
    >
  }
  const { GoogleAuth } = await import('google-auth-library')
  return new GoogleAuth({
    scopes: [CLOUD_PLATFORM_SCOPE],
    ...(auth.kind === 'keyFile' && { keyFilename: auth.path }),
    ...(projectId && { projectId }),
  })
}

async function createWizardVertexClient(data: VertexWizardData) {
  const [{ AnthropicVertex }] = await Promise.all([
    import('@anthropic-ai/vertex-sdk'),
  ])
  const googleAuth = await buildVertexGoogleAuth(
    resolveWizardAuth(data),
    data.projectId,
  )
  const args: ConstructorParameters<typeof AnthropicVertex>[0] = {
    region: data.region,
    projectId: data.projectId,
    googleAuth: googleAuth as unknown as ConstructorParameters<
      typeof AnthropicVertex
    >[0]['googleAuth'],
    maxRetries: 0,
    timeout: 15_000,
    fetchOptions: getProxyFetchOptions(),
  }
  return new AnthropicVertex(args)
}

export async function probeModel(
  data: VertexWizardData,
  model: string,
): Promise<Exclude<ProbeState, 'pending'>> {
  let client
  try {
    client = await createWizardVertexClient(data)
  } catch {
    return { ok: false, reason: 'auth' }
  }
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    })
    return { ok: true }
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status
    if (status === 401) {
      return { ok: false, reason: 'auth' }
    }
    if (status === 403) {
      return { ok: false, reason: 'permission' }
    }
    if (status === 400 || status === 404) {
      return { ok: false, reason: 'model' }
    }
    if (status === 429) {
      return { ok: true }
    }
    if (status === undefined) {
      return { ok: false, reason: 'network' }
    }
    return { ok: false, reason: 'other' }
  }
}

function formatVerifyError(
  err: unknown,
  data: VertexWizardData,
): { error: string; command?: string } {
  const message =
    (err as { message?: string } | undefined)?.message ?? String(err)
  if (
    data.authMethod === 'serviceAccount' &&
    /ENOENT|no such file/i.test(message)
  ) {
    return { error: `Service account key file not found: ${data.keyFile}` }
  }
  if (/Could not load the default credentials/i.test(message)) {
    return data.authMethod === 'adc'
      ? { error: 'No Application Default Credentials found. Run:', command: ADC_LOGIN_COMMAND }
      : {
          error:
            'No GCP credentials found in the environment. Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login.',
        }
  }
  if (/invalid_grant|Token has been expired|reauth/i.test(message)) {
    if (data.authMethod === 'serviceAccount') {
      return {
        error:
          'Service account credentials have been revoked or expired. Obtain a new key file from GCP IAM (IAM → Service Accounts → Keys → Add Key).',
      }
    }
    if (data.authMethod === 'adc') {
      return { error: 'GCP credentials expired. Run:', command: ADC_LOGIN_COMMAND }
    }
    return {
      error:
        'GCP credentials in the environment have expired or been revoked. Refresh them (gcloud auth application-default login for ADC, or replace the GOOGLE_APPLICATION_CREDENTIALS key file).',
    }
  }
  if (/Unable to detect a Project Id/i.test(message)) {
    return {
      error:
        'Could not determine a GCP project from the credentials. Go back and set the project ID explicitly.',
    }
  }
  if (/Timed out waiting for GCP/i.test(message)) {
    return {
      error:
        'Timed out resolving GCP credentials (no ADC, no key file, and no GCE metadata server).',
      ...(data.authMethod === 'adc' && { command: ADC_LOGIN_COMMAND }),
    }
  }
  return { error: message }
}

export async function verifyVertexCredentials(
  data: VertexWizardData,
): Promise<VerifyResult> {
  let identity: string
  try {
    const auth = await buildVertexGoogleAuth(
      resolveWizardAuth(data),
      data.projectId,
    )
    const probe = (async () => {
      await (await auth.getClient()).getAccessToken()
    })()
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(Error('Timed out waiting for GCP credentials')),
        GCP_CREDENTIALS_TIMEOUT_MS,
      )
    })
    await Promise.race([probe, timeout])
    let email: string | undefined
    try {
      email = (await auth.getCredentials()).client_email
    } catch {
      email = undefined
    }
    identity =
      email ??
      (data.authMethod === 'serviceAccount'
        ? `service account (${data.keyFile})`
        : 'Application Default Credentials')
  } catch (err) {
    return { status: 'error', ...formatVerifyError(err, data) }
  }
  const model = getDefaultVertexModels().haiku
  const result = await probeModel(data, model)
  if (result.ok) {
    return {
      status: 'ok',
      identity,
      note: `Test request to ${model} succeeded.`,
    }
  }
  switch (result.ok === false ? result.reason : 'other') {
    case 'auth':
      return {
        status: 'error',
        error:
          'Got a token, but Vertex AI rejected it. The credential may lack the cloud-platform scope.',
      }
    case 'permission':
      return {
        status: 'error',
        error: `Permission denied calling Vertex AI in project "${data.projectId}". The principal needs the aiplatform.endpoints.predict permission (Vertex AI User role), and the Vertex AI API must be enabled.`,
      }
    case 'model':
      return {
        status: 'ok',
        identity,
        note: `Credentials work, but ${model} returned not-found in ${data.region}. Pin a model you have access to on the next step, or try the 'global' region.`,
      }
    case 'network':
      return {
        status: 'error',
        error: `Could not reach Vertex AI in region "${data.region}". Check the region name and your network.`,
      }
    case 'other':
      return {
        status: 'ok',
        identity,
        note: `Credentials work, but the test request to ${model} failed. You can pin a different model on the next step.`,
      }
  }
}

export function gcloudConfigDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'gcloud')
  }
  return join(homedir(), '.config', 'gcloud')
}

export async function listGcloudProjects(): Promise<string[]> {
  const names = new Set<string>()
  const configDir = process.env.CLOUDSDK_CONFIG ?? gcloudConfigDir()
  try {
    const configurations = join(configDir, 'configurations')
    for (const file of await readdir(configurations)) {
      if (!file.startsWith('config_')) {
        continue
      }
      try {
        const text = await readFile(join(configurations, file), 'utf8')
        for (const match of text.matchAll(/^project\s*=\s*(\S+)/gm)) {
          const project = match[1]?.trim()
          if (project) {
            names.add(project)
          }
        }
      } catch {
        // A single unreadable configuration is expected.
      }
    }
  } catch {
    // Missing gcloud config dir is expected.
  }
  try {
    const adc = jsonParse(
      await readFile(join(configDir, 'application_default_credentials.json'), 'utf8'),
    ) as { quota_project_id?: string }
    if (adc.quota_project_id) {
      names.add(adc.quota_project_id)
    }
  } catch {
    // Missing ADC file is expected.
  }
  return [...names].sort()
}

export function isAuthMethod(value: string): value is VertexAuthMethod {
  return (
    value === 'adc' || value === 'serviceAccount' || value === 'environment'
  )
}
