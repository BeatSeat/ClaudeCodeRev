/**
 * Official 2.1.118 `vV$` / `Pk_`: cross-process lock around
 * ~/.claude/.credentials.json writes. Wraps a credentials provider so
 * concurrent Claude Code processes cannot corrupt the plaintext file.
 */
import { dirname } from 'path'
import { logEvent } from '../../services/analytics/index.js'
import { logError } from '../log.js'
import * as lockfile from '../lockfile.js'
import { sleep } from '../sleep.js'

const CREDENTIALS_LOCK_RETRIES = 5

export class CredentialsLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsLockError'
  }
}

export async function acquireCredentialsLock(
  dir: string,
): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await lockfile.lock(dir, {
        onCompromised: err => logError(err),
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'ELOCKED') throw err
      if (attempt >= CREDENTIALS_LOCK_RETRIES) {
        logEvent('tengu_wif_user_oauth_lock_retry_limit', { attempt })
        throw new CredentialsLockError(
          `Could not acquire credentials lock at ${dir} after ${CREDENTIALS_LOCK_RETRIES} retries`,
        )
      }
      logEvent('tengu_wif_user_oauth_lock_retry', { attempt })
      await sleep(1000 + Math.random() * 1000)
    }
  }
}

/**
 * Official 2.1.118 `withCredentialsLock`: wrap an async provider so each
 * invocation holds the credentials-directory lock.
 */
export function withCredentialsLock<T, Args extends unknown[]>(
  provider: (...args: Args) => Promise<T>,
  credentialsPath: string,
): (...args: Args) => Promise<T> {
  const dir = dirname(credentialsPath)
  return async (...args: Args) => {
    const release = await acquireCredentialsLock(dir)
    try {
      logEvent('tengu_wif_user_oauth_lock_acquired', {})
      return await provider(...args)
    } finally {
      logEvent('tengu_wif_user_oauth_lock_released', {})
      try {
        await release()
      } catch (err) {
        logError(err)
      }
    }
  }
}
