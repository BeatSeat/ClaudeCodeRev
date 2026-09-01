import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/** Official 2.1.132 vi_ — 16 MiB stdout cap before disconnect. */
export const STDIO_MCP_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** Official Sj$ / StdoutOverflowError — surfaced when stdout lacks JSON-RPC boundaries. */
export class StdoutOverflowError extends Error {
  override name = 'StdoutOverflowError'

  constructor(capBytes: number) {
    super(
      `wrote >${Math.round(capBytes / 1024 / 1024)}MB to stdout without a JSON-RPC message boundary. The server is likely writing logs or other non-protocol data to stdout instead of stderr. Disconnecting to prevent unbounded memory growth.`,
    )
  }
}

/** Official dd7 — bounded read buffer with overflow disconnect. */
class BoundedReadBuffer {
  private chunks: Buffer[] = []
  private byteLength = 0
  private overflowed = false
  private overflowThrown = false

  constructor(
    private capBytes: number,
    private onOverflow: (err: StdoutOverflowError) => void,
  ) {}

  append(chunk: Buffer): void {
    if (this.overflowed) return
    if (this.byteLength + chunk.length > this.capBytes) {
      this.chunks = []
      this.byteLength = 0
      this.overflowed = true
      this.onOverflow(new StdoutOverflowError(this.capBytes))
      return
    }
    this.chunks.push(chunk)
    this.byteLength += chunk.length
  }

  readMessage(): JSONRPCMessage | null {
    if (this.overflowed) {
      if (this.overflowThrown) return null
      this.overflowThrown = true
      throw new StdoutOverflowError(this.capBytes)
    }
    if (this.chunks.length === 0) return null
    const last = this.chunks.at(-1)!
    const newlineIndex = last.indexOf(10)
    if (newlineIndex === -1) return null
    const buf =
      this.chunks.length === 1 ? last : Buffer.concat(this.chunks)
    const lastChunkStart = buf.length - last.length
    const absoluteNewline = lastChunkStart + newlineIndex
    const line = buf.toString('utf8', 0, absoluteNewline).replace(/\r$/, '')
    const remainder = buf.subarray(absoluteNewline + 1)
    this.chunks = remainder.length > 0 ? [remainder] : []
    this.byteLength = remainder.length
    return deserializeMessage(line)
  }

  clear(): void {
    this.chunks = []
    this.byteLength = 0
  }
}

/** Official Rj$ — StdioClientTransport with bounded stdout read buffer. */
export class BoundedStdioClientTransport extends StdioClientTransport {
  overflowError?: StdoutOverflowError

  constructor(server: StdioServerParameters) {
    super(server)
    const internals = this as unknown as {
      _readBuffer: BoundedReadBuffer
    }
    internals._readBuffer = new BoundedReadBuffer(
      STDIO_MCP_MAX_BUFFER_BYTES,
      err => {
        this.overflowError = err
        queueMicrotask(() => void this.close())
      },
    )
  }
}
