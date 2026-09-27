import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from './debug.js'
import { hasNodeOption } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'

type CertStore = 'bundled' | 'system'

const DEFAULT_CERT_STORES: CertStore[] = ['bundled', 'system']

/**
 * Official 2.1.101 fd5: parse CLAUDE_CODE_CERT_STORE, then --use-system-ca
 * flags, otherwise both bundled Mozilla roots and the OS CA store.
 */
function resolveCertStores(): CertStore[] {
  const raw = process.env.CLAUDE_CODE_CERT_STORE
  if (raw) {
    const stores: CertStore[] = []
    for (const part of raw.split(',')) {
      const source = part.trim().toLowerCase()
      if (source === 'bundled' || source === 'system') {
        if (!stores.includes(source)) stores.push(source)
      } else if (source) {
        logForDebugging(
          `CA certs: unrecognized CLAUDE_CODE_CERT_STORE source '${source}', ignoring`,
          { level: 'warn' },
        )
      }
    }
    return stores.length > 0 ? stores : DEFAULT_CERT_STORES
  }
  if (hasNodeOption('--use-system-ca') || hasNodeOption('--use-openssl-ca')) {
    return ['system']
  }
  return DEFAULT_CERT_STORES
}

/**
 * Load CA certificates for TLS connections.
 *
 * Since setting `ca` on an HTTPS agent replaces the default certificate store,
 * we must always include the requested base CAs when returning a list.
 *
 * Official 2.1.101 Mm:
 * - Default stores are bundled + system (enterprise TLS proxies work without
 *   extra setup). Set `CLAUDE_CODE_CERT_STORE=bundled` to use only Mozilla CAs.
 * - On Node, if neither NODE_EXTRA_CA_CERTS nor CLAUDE_CODE_CERT_STORE is set,
 *   return undefined so the runtime default store applies.
 * - On Bun, always materialize the resolved stores.
 *
 * Memoized. Call clearCACertsCache() after env/settings changes.
 */
export const getCACertificates = memoize((): string[] | undefined => {
  const stores = resolveCertStores()
  const extraCertsPath = process.env.NODE_EXTRA_CA_CERTS
  const useBundled = stores.includes('bundled')
  const useSystem = stores.includes('system')

  logForDebugging(
    `CA certs: stores=${stores.join(',')}, extraCertsPath=${extraCertsPath}`,
  )

  if (
    typeof Bun === 'undefined' &&
    !extraCertsPath &&
    !process.env.CLAUDE_CODE_CERT_STORE
  ) {
    return undefined
  }

  /* eslint-disable @typescript-eslint/no-require-imports */
  const tls = require('tls') as typeof import('tls')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const getCACerts = (
    tls as typeof tls & { getCACertificates?: (type: string) => string[] }
  ).getCACertificates

  if (!useBundled && useSystem && !getCACerts) {
    logForDebugging(
      'CA certs: stores=system but system CA API unavailable, deferring to runtime',
    )
    return undefined
  }

  const certs: string[] = []

  if (useBundled) {
    certs.push(...tls.rootCertificates)
    logForDebugging(
      `CA certs: Loaded ${tls.rootCertificates.length} bundled root certificates`,
    )
  }

  if (useSystem) {
    try {
      const systemCAs = getCACerts?.('system')
      if (systemCAs && systemCAs.length > 0) {
        certs.push(...systemCAs)
        logForDebugging(
          `CA certs: Loaded ${systemCAs.length} system CA certificates`,
        )
      } else {
        logForDebugging(
          `CA certs: system store ${getCACerts ? 'returned empty' : 'unavailable'}`,
        )
        if (!useBundled) {
          certs.push(...tls.rootCertificates)
        }
      }
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to load system CA certificates: ${error}`,
        { level: 'error' },
      )
      if (!useBundled) {
        certs.push(...tls.rootCertificates)
      }
    }
  }

  if (extraCertsPath) {
    try {
      const extraCert = getFsImplementation().readFileSync(extraCertsPath, {
        encoding: 'utf8',
      })
      certs.push(extraCert)
      logForDebugging(
        `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (${extraCertsPath})`,
      )
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to read NODE_EXTRA_CA_CERTS file (${extraCertsPath}): ${error}`,
        { level: 'error' },
      )
    }
  }

  return certs.length > 0 ? [...new Set(certs)] : undefined
})

/**
 * Clear the CA certificates cache.
 * Call this when environment variables that affect CA certs may have changed
 * (e.g., NODE_EXTRA_CA_CERTS, CLAUDE_CODE_CERT_STORE, NODE_OPTIONS).
 */
export function clearCACertsCache(): void {
  getCACertificates.cache.clear?.()
  logForDebugging('Cleared CA certificates cache')
}
