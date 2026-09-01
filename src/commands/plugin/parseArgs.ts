// Parse plugin subcommand arguments into structured commands
export type ParsedCommand =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'install'; marketplace?: string; plugin?: string }
  | { type: 'manage' }
  | { type: 'uninstall'; plugin?: string }
  | { type: 'enable'; plugin?: string }
  | { type: 'disable'; plugin?: string }
  | { type: 'validate'; path?: string }
  | {
      type: 'tag'
      path?: string
      push?: boolean
      dryRun?: boolean
      force?: boolean
      unknownFlag?: string
    }
  | {
      type: 'marketplace'
      action?: 'add' | 'remove' | 'update' | 'list'
      target?: string
    }

export function parsePluginArgs(args?: string): ParsedCommand {
  if (!args) {
    return { type: 'menu' }
  }

  const parts = args.trim().split(/\s+/)
  const command = parts[0]?.toLowerCase()

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      return { type: 'help' }

    case 'install':
    case 'i': {
      const target = parts[1]
      if (!target) {
        return { type: 'install' }
      }

      // plugin@marketplace — lastIndexOf so @scope/pkg is not a marketplace
      const at = target.lastIndexOf('@')
      if (at > 0) {
        return {
          type: 'install',
          plugin: target.slice(0, at),
          marketplace: target.slice(at + 1),
        }
      }

      // Check if the target looks like a marketplace (URL or path).
      // Leading @ (scoped npm names) is not a marketplace.
      const isMarketplace =
        !target.startsWith('@') &&
        (target.startsWith('http://') ||
          target.startsWith('https://') ||
          target.startsWith('file://') ||
          target.includes('/') ||
          target.includes('\\'))

      if (isMarketplace) {
        // This is a marketplace URL/path, no plugin specified
        return { type: 'install', marketplace: target }
      }

      // Otherwise treat it as a plugin name
      return { type: 'install', plugin: target }
    }

    case 'manage':
      return { type: 'manage' }

    case 'uninstall':
      return { type: 'uninstall', plugin: parts[1] }

    case 'enable':
      return { type: 'enable', plugin: parts[1] }

    case 'disable':
      return { type: 'disable', plugin: parts[1] }

    case 'validate': {
      const target = parts.slice(1).join(' ').trim()
      return { type: 'validate', path: target || undefined }
    }

    case 'tag': {
      let path: string | undefined
      let push = false
      let dryRun = false
      let force = false
      let unknownFlag: string | undefined
      for (const part of parts.slice(1)) {
        if (part === '--push') push = true
        else if (part === '--dry-run') dryRun = true
        else if (part === '-f' || part === '--force') force = true
        else if (part.startsWith('-')) unknownFlag = part
        else if (!path) path = part
      }
      return { type: 'tag', path, push, dryRun, force, unknownFlag }
    }

    case 'marketplace':
    case 'market': {
      const action = parts[1]?.toLowerCase()
      const target = parts.slice(2).join(' ')

      switch (action) {
        case 'add':
          return { type: 'marketplace', action: 'add', target }
        case 'remove':
        case 'rm':
          return { type: 'marketplace', action: 'remove', target }
        case 'update':
          return { type: 'marketplace', action: 'update', target }
        case 'list':
          return { type: 'marketplace', action: 'list' }
        default:
          // No action specified, show marketplace menu
          return { type: 'marketplace' }
      }
    }

    default:
      // Unknown command, show menu
      return { type: 'menu' }
  }
}
