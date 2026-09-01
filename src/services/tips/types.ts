import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThemeName } from '../../utils/theme.js'

export type TipContext = {
  theme: ThemeName
  readFileState?: FileStateCache
  bashTools?: Set<string>
  /** Official 2.1.152 — hostnames from https?:// URLs in bash commands. */
  bashHosts?: Set<string>
}

export type Tip = {
  id: string
  content: (ctx: { theme: ThemeName }) => Promise<string>
  cooldownSessions: number
  isRelevant: (context?: TipContext) => Promise<boolean>
  priority?: number
  providerAgnostic?: boolean
}
