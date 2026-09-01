import { link, mkdir, stat, unlink, writeFile } from 'fs/promises'
import { join, sep } from 'path'
import { isInBundledMode } from './bundledMode.js'
import { getPlatform } from './platform.js'
import { getXDGDataHome } from './xdg.js'

const CLAUDE_CODE_APP_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claude-code</string><key>CFBundleName</key><string>Claude Code</string><key>CFBundleDisplayName</key><string>Claude Code</string><key>CFBundleExecutable</key><string>claude</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>NSMicrophoneUsageDescription</key><string>Claude Code uses the microphone for voice dictation.</string></dict></plist>
`

/** Official 2.1.153 `UJz`: native-install ClaudeCode.app hardlink for TCC identity. */
export async function ensureClaudeCodeAppExecPath(): Promise<string | null> {
  const claudeHome = join(getXDGDataHome(), 'claude')
  if (!process.execPath.startsWith(join(claudeHome, 'versions') + sep)) {
    return null
  }
  const macosDir = join(claudeHome, 'ClaudeCode.app', 'Contents', 'MacOS')
  const linked = join(macosDir, 'claude')
  try {
    const currentIno = (await stat(process.execPath)).ino
    try {
      if ((await stat(linked)).ino === currentIno) return linked
      await unlink(linked)
    } catch {
      // missing link — create below
    }
    await mkdir(macosDir, { recursive: true })
    await writeFile(join(macosDir, '..', 'Info.plist'), CLAUDE_CODE_APP_PLIST)
    await link(process.execPath, linked)
    return linked
  } catch {
    return null
  }
}

/**
 * Official 2.1.143 `LS4`: on macOS, spawn a copy of this process with
 * `responsibility_spawnattrs_setdisclaim` so TCC does not attribute the
 * child's file/network access to Terminal.app. No-op when already
 * disclaimed (`CLAUDE_BG_TCC_DISCLAIMED`) or when bun:ffi is unavailable.
 *
 * Called first from `--bg-pty-host` (bundle `ZU5`).
 */
export async function disclaimMacOSTccResponsibility(): Promise<void> {
  if (getPlatform() !== 'macos') return
  if (process.env.CLAUDE_BG_TCC_DISCLAIMED) {
    delete process.env.CLAUDE_BG_TCC_DISCLAIMED
    return
  }
  const execPath = (await ensureClaudeCodeAppExecPath()) ?? process.execPath
  try {
    // bun:ffi is only present under Bun. Keep the require dynamic so Node
    // test/typecheck graphs do not load it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as {
      dlopen: (
        path: string,
        symbols: Record<string, { args: string[]; returns: string }>,
      ) => { symbols: Record<string, (...args: unknown[]) => number> }
      ptr: (buf: Buffer) => number | bigint
    }
    const { symbols } = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      posix_spawnattr_init: { args: ['ptr'], returns: 'int' },
      posix_spawnattr_setflags: { args: ['ptr', 'i16'], returns: 'int' },
      posix_spawnattr_destroy: { args: ['ptr'], returns: 'int' },
      responsibility_spawnattrs_setdisclaim: {
        args: ['ptr', 'int'],
        returns: 'int',
      },
      posix_spawn: {
        args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
        returns: 'int',
      },
    })
    const attr = new BigUint64Array(1)
    if (symbols.posix_spawnattr_init(attr) !== 0) return
    try {
      // POSIX_SPAWN_CLOEXEC_DEFAULT = 64
      if (
        symbols.posix_spawnattr_setflags(attr, 64) !== 0 ||
        symbols.responsibility_spawnattrs_setdisclaim(attr, 1) !== 0
      ) {
        return
      }
      const keepAlive: Buffer[] = []
      const cstr = (value: string): bigint => {
        const buf = Buffer.from(value + '\0', 'utf8')
        keepAlive.push(buf)
        return BigInt(ffi.ptr(buf))
      }
      const cstrArray = (values: string[]): BigUint64Array => {
        const arr = new BigUint64Array(values.length + 1)
        values.forEach((value, i) => {
          arr[i] = cstr(value)
        })
        return arr
      }
      const argv = isInBundledMode()
        ? [execPath]
        : [execPath, process.argv[1]!]
      const file = Buffer.from(execPath + '\0', 'utf8')
      keepAlive.push(file)
      const argvPtrs = cstrArray([...argv, ...process.argv.slice(2)])
      const envPtrs = cstrArray(
        Object.entries({
          ...process.env,
          CLAUDE_BG_TCC_DISCLAIMED: '1',
        }).flatMap(([key, value]) =>
          value === undefined ? [] : [`${key}=${value}`],
        ),
      )
      symbols.posix_spawn(null, file, null, attr, argvPtrs, envPtrs)
    } finally {
      symbols.posix_spawnattr_destroy(attr)
    }
  } catch {
    // bun:ffi / libSystem missing — leave TCC attribution as-is.
  }
}
