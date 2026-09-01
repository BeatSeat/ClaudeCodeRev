import { chmodSync } from 'fs'
import { join } from 'path'
import { logEvent } from '../../services/analytics/index.js'
import { getSecureStorageConfigDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import * as lockfile from '../lockfile.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import {
  CredentialsLockError,
  withCredentialsLock,
} from './credentialsLock.js'
import type { SecureStorage, SecureStorageData } from './types.js'

export { withCredentialsLock }

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getSecureStorageConfigDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

export const plainTextStorage = {
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // Official 2.1.118: cross-process lock around ~/.claude/.credentials.json
    // writes (sync port of withCredentialsLock / Pk_).
    const { storageDir, storagePath } = getStoragePath()
    let release: (() => void) | undefined
    try {
      try {
        getFsImplementation().mkdirSync(storageDir)
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }
      const maxRetries = 5
      for (let attempt = 0; ; attempt++) {
        try {
          release = lockfile.lockSync(storageDir, {
            onCompromised: err => logError(err),
          })
          break
        } catch (err) {
          const code = (err as { code?: string }).code
          if (code !== 'ELOCKED') throw err
          if (attempt >= maxRetries) {
            logEvent('tengu_wif_user_oauth_lock_retry_limit', { attempt })
            throw new CredentialsLockError(
              `Could not acquire credentials lock at ${storageDir} after ${maxRetries} retries`,
            )
          }
          logEvent('tengu_wif_user_oauth_lock_retry', { attempt })
          const until = Date.now() + 1000 + Math.random() * 1000
          while (Date.now() < until) {
            // busy-wait: update() is sync
          }
        }
      }
      logEvent('tengu_wif_user_oauth_lock_acquired', {})
      writeFileSync_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        flush: false,
      })
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    } finally {
      if (release) {
        logEvent('tengu_wif_user_oauth_lock_released', {})
        try {
          release()
        } catch (err) {
          logError(err)
        }
      }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
