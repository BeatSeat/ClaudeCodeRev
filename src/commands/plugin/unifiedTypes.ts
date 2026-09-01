import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { PersistablePluginScope } from '../../utils/plugins/pluginIdentifier.js'

export type UnifiedInstalledItem =
  | {
      type: 'plugin'
      id: string
      name: string
      description?: string
      marketplace: string
      scope: 'user' | 'project' | 'local' | 'managed' | 'builtin'
      isEnabled: boolean
      errorCount: number
      errors: PluginError[]
      plugin: LoadedPlugin
      pendingEnable?: boolean
      pendingUpdate?: boolean
      pendingToggle?: 'will-enable' | 'will-disable'
    }
  | {
      type: 'failed-plugin'
      id: string
      name: string
      marketplace: string
      scope: PersistablePluginScope
      errorCount: number
      errors: PluginError[]
    }
  | {
      type: 'flagged-plugin'
      id: string
      name: string
      marketplace: string
      scope: 'flagged'
      reason: string
      text: string
      flaggedAt: string
    }
  | {
      type: 'mcp'
      id: string
      name: string
      description?: string
      scope: string
      status: 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed'
      client: MCPServerConnection
      indented?: boolean
    }

/** Official 2.1.110 Installed-tab row: real item or the folded disabled header. */
export type InstalledListSection =
  | 'attention'
  | 'favorites'
  | 'main'
  | 'disabled'

export type InstalledListRow =
  | {
      kind: 'item'
      section: InstalledListSection
      item: UnifiedInstalledItem
    }
  | { kind: 'disabled-header'; count: number }
