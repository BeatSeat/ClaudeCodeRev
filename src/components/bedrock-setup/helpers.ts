import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  applyBedrockRegionPrefix,
  type BedrockRegionPrefix,
  findFirstMatch,
} from '../../utils/model/bedrock.js'
import { ALL_MODEL_CONFIGS } from '../../utils/model/configs.js'
import { getAWSClientProxyConfig, getProxyFetchOptions } from '../../utils/proxy.js'
import type {
  BedrockAuthMethod,
  BedrockWizardData,
  ProbeReason,
  ProbeState,
  VerifyResult,
} from './types.js'

export const PIN_TIERS = ['sonnet', 'opus', 'haiku'] as const

export const TIER_LABELS = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
} as const

export const PROBE_REASON_LABELS: Record<ProbeReason, string> = {
  auth: 'auth failed',
  permission: 'no InvokeModel permission',
  model: 'not enabled in this account',
  network: 'unreachable',
  other: 'request failed',
}

const HIDDEN_ENV_KEYS = new Set([
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
])

const DEFAULT_MODEL_KEYS = {
  sonnet: 'sonnet45',
  opus: 'opus46',
  haiku: 'haiku45',
} as const

type AwsCreds = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

type AwsCredsProvider = () => Promise<AwsCreds>

type ClientAuth =
  | { kind: 'bearer'; token: string | undefined }
  | { kind: 'sigv4'; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: 'default' }

export function geoPrefixFromRegion(region?: string): BedrockRegionPrefix {
  const value = region ?? ''
  if (value.startsWith('us-') && !value.startsWith('us-gov-')) {
    return 'us'
  }
  if (value.startsWith('eu-')) {
    return 'eu'
  }
  if (value.startsWith('ap-')) {
    return 'apac'
  }
  return 'global'
}

export function getDefaultModelCandidates(region?: string): Record<
  'sonnet' | 'opus' | 'haiku',
  { needle: string; fallback: string }
> {
  const prefix = geoPrefixFromRegion(region)
  const make = (key: (typeof DEFAULT_MODEL_KEYS)[keyof typeof DEFAULT_MODEL_KEYS]) => ({
    needle: ALL_MODEL_CONFIGS[key].firstParty,
    fallback: applyBedrockRegionPrefix(ALL_MODEL_CONFIGS[key].bedrock, prefix),
  })
  return {
    sonnet: make(DEFAULT_MODEL_KEYS.sonnet),
    opus: make(DEFAULT_MODEL_KEYS.opus),
    haiku: make(DEFAULT_MODEL_KEYS.haiku),
  }
}

export function buildBedrockEnv(
  data: BedrockWizardData,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
    AWS_REGION: data.region,
    AWS_PROFILE: undefined,
    AWS_BEARER_TOKEN_BEDROCK: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
    ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
  }
  switch (data.authMethod) {
    case 'profile':
      env.AWS_PROFILE = data.awsProfile
      break
    case 'bearer':
      env.AWS_BEARER_TOKEN_BEDROCK = data.bearerToken
      break
    case 'accessKey':
      env.AWS_ACCESS_KEY_ID = data.accessKeyId
      env.AWS_SECRET_ACCESS_KEY = data.secretAccessKey
      if (data.sessionToken) {
        env.AWS_SESSION_TOKEN = data.sessionToken
      }
      break
    case 'environment':
    case undefined:
      break
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

export function isHiddenEnvKey(key: string): boolean {
  return HIDDEN_ENV_KEYS.has(key)
}

export async function listAwsProfiles(): Promise<string[]> {
  const names = new Set<string>()
  const home = homedir()
  const sources: { path: string; re: RegExp }[] = [
    {
      path: join(home, '.aws', 'config'),
      re: /^\[(?:profile\s+)?([^\]]+)\]/gm,
    },
    {
      path: join(home, '.aws', 'credentials'),
      re: /^\[([^\]]+)\]/gm,
    },
  ]
  for (const { path, re } of sources) {
    try {
      const text = await readFile(path, 'utf8')
      for (const match of text.matchAll(re)) {
        const name = match[1]?.trim()
        if (name && !name.startsWith('sso-session ')) {
          names.add(name)
        }
      }
    } catch {
      // Missing config/credentials files are expected.
    }
  }
  return [...names].sort()
}

function applyBedrockClientAuth<T extends Record<string, unknown>>(
  args: T,
  auth: ClientAuth,
): T {
  switch (auth.kind) {
    case 'bearer':
      return {
        ...args,
        apiKey: auth.token,
      }
    case 'sigv4':
      return {
        ...args,
        awsAccessKey: auth.accessKeyId,
        awsSecretKey: auth.secretAccessKey,
        awsSessionToken: auth.sessionToken,
      }
    case 'default':
      return args
  }
}

async function getCredentialsProvider(
  data: BedrockWizardData,
): Promise<AwsCredsProvider | undefined> {
  switch (data.authMethod) {
    case 'profile': {
      const { fromNodeProviderChain } = await import(
        '@aws-sdk/credential-providers'
      )
      return fromNodeProviderChain({
        profile: data.awsProfile,
        ignoreCache: true,
      })
    }
    case 'accessKey':
      return async () => ({
        accessKeyId: data.accessKeyId!,
        secretAccessKey: data.secretAccessKey!,
        ...(data.sessionToken && { sessionToken: data.sessionToken }),
      })
    case 'environment':
      return undefined
    default:
      return undefined
  }
}

async function resolveWizardAuth(data: BedrockWizardData): Promise<ClientAuth> {
  if (data.authMethod === 'bearer') {
    return { kind: 'bearer', token: data.bearerToken }
  }
  const provider = await getCredentialsProvider(data)
  if (!provider) {
    return { kind: 'default' }
  }
  const creds = await provider()
  return {
    kind: 'sigv4',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  }
}

async function createWizardBedrockClient(data: BedrockWizardData) {
  const [{ AnthropicBedrock }] = await Promise.all([
    import('@anthropic-ai/bedrock-sdk'),
  ])
  const args = {
    awsRegion: data.region,
    maxRetries: 0,
    fetchOptions: getProxyFetchOptions(),
  }
  return new AnthropicBedrock(
    applyBedrockClientAuth(args, await resolveWizardAuth(data)),
  )
}

export async function probeModel(
  data: BedrockWizardData,
  model: string,
): Promise<Exclude<ProbeState, 'pending'>> {
  let client
  try {
    client = await createWizardBedrockClient(data)
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
  data: BedrockWizardData,
): { error: string; command?: string } {
  const raw = err as { name?: string; message?: string } | undefined
  const name = raw?.name ?? 'Error'
  const message = raw?.message ?? String(err)
  const command =
    data.authMethod === 'profile'
      ? `aws sso login --profile ${data.awsProfile}`
      : undefined
  switch (name) {
    case 'CredentialsProviderError':
      return data.authMethod === 'profile'
        ? {
            error: `Could not load credentials for profile "${data.awsProfile}". If this is an SSO profile, run:`,
            command,
          }
        : { error: `No AWS credentials found. ${message}` }
    case 'ExpiredTokenException':
    case 'TokenRefreshRequired':
      return data.authMethod === 'profile'
        ? { error: 'SSO session expired. Run:', command }
        : { error: `Credentials expired. ${message}` }
    case 'ForbiddenException':
      return data.authMethod === 'profile'
        ? {
            error: `SSO portal denied access to the role for profile "${data.awsProfile}". The permission set may have been revoked — check your AWS access portal.`,
          }
        : { error: `Forbidden. ${message}` }
    case 'AccessDeniedException':
      return {
        error: `Access denied. Your IAM role needs bedrock:ListInferenceProfiles permission. ${message}`,
      }
    case 'UnrecognizedClientException':
    case 'InvalidSignatureException':
      return { error: `Invalid credentials. ${message}` }
    case 'UnknownEndpoint':
    case 'ENOTFOUND':
      return {
        error: `Cannot reach AWS in region "${data.region}". Check the region name and your network.`,
      }
    default:
      return { error: `${name}: ${message}` }
  }
}

async function verifyBearerToken(data: BedrockWizardData): Promise<VerifyResult> {
  const model = getDefaultModelCandidates(data.region).haiku.fallback
  const result = await probeModel(data, model)
  if (result.ok) {
    return {
      status: 'ok',
      identity: 'Bedrock API key',
      profiles: [],
      note: `Test request to ${model} succeeded.`,
    }
  }
  switch (result.ok === false ? result.reason : 'other') {
    case 'auth':
      return {
        status: 'error',
        error: 'Invalid Bedrock API key. Check the key and try again.',
      }
    case 'permission':
      return {
        status: 'error',
        error:
          'API key was rejected. Your IAM policy may be missing bedrock:CallWithBearerToken or bedrock:InvokeModel.',
      }
    case 'model':
      return {
        status: 'ok',
        identity: 'Bedrock API key',
        profiles: [],
        note: `The key works, but ${model} is not enabled in your account. Pin a model you have access to on the next step.`,
      }
    case 'network':
      return {
        status: 'error',
        error: `Could not reach Bedrock in region "${data.region}". Check the region name and your network.`,
      }
    case 'other':
      return {
        status: 'error',
        error: 'The test request failed. Check the key and region.',
      }
  }
}

export async function verifyBedrockCredentials(
  data: BedrockWizardData,
): Promise<VerifyResult> {
  if (data.authMethod === 'bearer') {
    return verifyBearerToken(data)
  }
  try {
    const credentials = await getCredentialsProvider(data)
    const clientConfig = {
      ...(await getAWSClientProxyConfig()),
      region: data.region,
      ...(credentials && { credentials }),
    }
    const { STSClient, GetCallerIdentityCommand } = await import(
      '@aws-sdk/client-sts'
    )
    const identity = await new STSClient(clientConfig).send(
      new GetCallerIdentityCommand({}),
    )
    const label = identity.Arn ?? identity.UserId ?? '(unknown)'
    const { BedrockClient, ListInferenceProfilesCommand } = await import(
      '@aws-sdk/client-bedrock'
    )
    const bedrock = new BedrockClient(clientConfig)
    const profiles: string[] = []
    let nextToken: string | undefined
    do {
      const response = await bedrock.send(
        new ListInferenceProfilesCommand({
          ...(nextToken && { nextToken }),
          typeEquals: 'SYSTEM_DEFINED',
        }),
      )
      for (const summary of response.inferenceProfileSummaries ?? []) {
        if (summary.inferenceProfileId?.includes('anthropic')) {
          profiles.push(summary.inferenceProfileId)
        }
      }
      nextToken = response.nextToken
    } while (nextToken)
    return { status: 'ok', identity: label, profiles }
  } catch (err) {
    return { status: 'error', ...formatVerifyError(err, data) }
  }
}

export function pickDefaultPinnedId(
  profiles: string[],
  defaults: { needle: string; fallback: string },
): string {
  return findFirstMatch(profiles, defaults.needle) ?? defaults.fallback
}

export function isAuthMethod(
  value: string,
): value is BedrockAuthMethod {
  return (
    value === 'profile' ||
    value === 'bearer' ||
    value === 'accessKey' ||
    value === 'environment'
  )
}
