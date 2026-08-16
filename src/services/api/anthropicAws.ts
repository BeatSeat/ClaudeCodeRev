import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity } from '@smithy/types'

/** Official bundled AnthropicAws signing name (2.1.90+). */
export const ANTHROPIC_AWS_SERVICE = 'aws-external-anthropic'

export type AnthropicAwsProviderChainResolver = () => Promise<
  () => Promise<AwsCredentialIdentity>
>

export type AnthropicAwsOptions = ClientOptions & {
  awsRegion?: string | null
  awsAccessKey?: string | null
  awsSecretAccessKey?: string | null
  awsSessionToken?: string | null
  awsProfile?: string | null
  providerChainResolver?: AnthropicAwsProviderChainResolver | null
  workspaceId?: string | null
  skipAuth?: boolean
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

function defaultBaseURL(region: string | undefined): string | undefined {
  return region ? `https://${ANTHROPIC_AWS_SERVICE}.${region}.api.aws` : undefined
}

function mergeDefaultHeaders(
  workspaceId: string | undefined,
  extra: ClientOptions['defaultHeaders'],
): ClientOptions['defaultHeaders'] {
  if (!workspaceId) {
    return extra
  }
  return {
    'anthropic-workspace-id': workspaceId,
    ...(extra && typeof extra === 'object' && !Array.isArray(extra)
      ? (extra as Record<string, string>)
      : {}),
  }
}

async function resolveCredentials(
  options: AnthropicAwsOptions,
): Promise<AwsCredentialIdentity> {
  if (options.awsAccessKey && options.awsSecretAccessKey) {
    return {
      accessKeyId: options.awsAccessKey,
      secretAccessKey: options.awsSecretAccessKey,
      ...(options.awsSessionToken != null && {
        sessionToken: options.awsSessionToken,
      }),
    }
  }
  if (options.providerChainResolver) {
    return (await options.providerChainResolver())()
  }
  const accessKeyId = readEnv('AWS_ACCESS_KEY_ID')
  const secretAccessKey = readEnv('AWS_SECRET_ACCESS_KEY')
  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: readEnv('AWS_SESSION_TOKEN'),
    }
  }
  throw new Error(
    'No AWS credentials found for Claude Platform on AWS. Set awsAccessKey/awsSecretAccessKey, ANTHROPIC_AWS_API_KEY, or standard AWS credential env vars.',
  )
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'connection') {
      record[key] = value
    }
  })
  return record
}

async function signFetch(
  inner: typeof globalThis.fetch,
  options: AnthropicAwsOptions,
  region: string,
): Promise<typeof globalThis.fetch> {
  const signer = new SignatureV4({
    service: ANTHROPIC_AWS_SERVICE,
    region,
    credentials: () => resolveCredentials(options),
    sha256: Sha256,
  })
  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
    )
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : 'POST')
    ).toUpperCase()
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    const headerRecord = headersToRecord(headers)
    headerRecord.host = url.hostname
    const query: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      query[key] = value
    })
    const body =
      init?.body ?? (input instanceof Request ? input.body : undefined)
    const signed = await signer.sign(
      new HttpRequest({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        query,
        headers: headerRecord,
        body: body ?? undefined,
      }),
    )
    const signedHeaders = new Headers()
    for (const [key, value] of Object.entries(signed.headers)) {
      if (value !== undefined) {
        signedHeaders.set(key, Array.isArray(value) ? value.join(',') : value)
      }
    }
    return inner(input, { ...init, method, headers: signedHeaders, body })
  }
}

/**
 * Official 2.1.90 AnthropicAws client: first-party API shape on
 * `aws-external-anthropic.<region>.api.aws`, authenticated with
 * ANTHROPIC_AWS_API_KEY or SigV4 (`aws-external-anthropic`).
 */
export class AnthropicAws extends Anthropic {
  readonly awsRegion: string | undefined
  readonly workspaceId: string | undefined
  readonly skipAuth: boolean

  constructor({
    awsRegion,
    baseURL,
    apiKey,
    awsAccessKey = null,
    awsSecretAccessKey = null,
    awsSessionToken = null,
    awsProfile,
    providerChainResolver = null,
    workspaceId,
    skipAuth = false,
    fetch: fetchOverride,
    ...rest
  }: AnthropicAwsOptions = {}) {
    const region =
      awsRegion ?? readEnv('AWS_REGION') ?? readEnv('AWS_DEFAULT_REGION')
    const resolvedBaseURL =
      baseURL ?? readEnv('ANTHROPIC_AWS_BASE_URL') ?? defaultBaseURL(region)
    if (!resolvedBaseURL && !skipAuth) {
      throw new Error(
        'No AWS region or base URL found. Set `awsRegion` in the constructor, the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variable, or provide a `baseURL` / `ANTHROPIC_AWS_BASE_URL` environment variable.',
      )
    }
    if ((awsAccessKey != null) !== (awsSecretAccessKey != null)) {
      throw new Error(
        '`awsAccessKey` and `awsSecretAccessKey` must be provided together. You provided only one.',
      )
    }
    const hasStaticCreds = awsAccessKey != null && awsSecretAccessKey != null
    const hasProfile = awsProfile != null
    let resolvedKey: string | null | undefined
    if (apiKey != null) {
      resolvedKey = typeof apiKey === 'string' ? apiKey : undefined
    } else if (!hasStaticCreds && !hasProfile) {
      resolvedKey = readEnv('ANTHROPIC_AWS_API_KEY')
    }
    const resolvedWorkspace =
      workspaceId ?? readEnv('ANTHROPIC_AWS_WORKSPACE_ID')
    if (!resolvedWorkspace && !skipAuth) {
      throw new Error(
        'No workspace ID found. Set `workspaceId` in the constructor or the `ANTHROPIC_AWS_WORKSPACE_ID` environment variable.',
      )
    }
    const useSigV4 = resolvedKey == null && !skipAuth
    if (useSigV4 && !region) {
      throw new Error(
        'No AWS region found. Set `awsRegion` in the constructor or the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variable.',
      )
    }
    const signingOptions: AnthropicAwsOptions = {
      awsAccessKey,
      awsSecretAccessKey,
      awsSessionToken,
      awsProfile,
      providerChainResolver,
    }
    const innerFetch = fetchOverride ?? globalThis.fetch
    let fetchImpl = innerFetch
    if (useSigV4 && region) {
      // Sign once-per-request; credential resolution is deferred to sign time.
      const signedFetchPromise = signFetch(innerFetch, signingOptions, region)
      fetchImpl = (input, init) =>
        signedFetchPromise.then(signed => signed(input, init))
    }
    super({
      ...rest,
      apiKey: resolvedKey ?? null,
      baseURL: resolvedBaseURL,
      defaultHeaders: mergeDefaultHeaders(
        resolvedWorkspace,
        rest.defaultHeaders,
      ),
      fetch: fetchImpl,
    })
    this.awsRegion = region
    this.workspaceId = resolvedWorkspace
    this.skipAuth = skipAuth
  }
}
