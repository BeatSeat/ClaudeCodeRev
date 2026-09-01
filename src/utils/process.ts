import chalk from 'chalk'

const STREAM_GONE_ERRNOS = new Set(['EPIPE', 'EIO', 'ENXIO', 'EBADF'])

type StreamWithDestroy = {
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown
  destroy?: () => void
}

export function handleStreamGoneErrors(
  stream: StreamWithDestroy,
  onGone?: (code: string) => void,
): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== undefined && STREAM_GONE_ERRNOS.has(err.code)) {
      try {
        stream.destroy?.()
      } catch {
        // ignore destroy failures on a already-gone stream
      }
      onGone?.(err.code)
    }
  })
}

// Prevents memory leak when pipe is broken (e.g., `claude -p | head -1`)
export function registerProcessIOErrorHandlers(
  onGone?: (stream: 'stdin' | 'stdout', code: string) => void,
): void {
  handleStreamGoneErrors(process.stdin, code => onGone?.('stdin', code))
  handleStreamGoneErrors(process.stdout, code => onGone?.('stdout', code))
  handleStreamGoneErrors(process.stderr)
}

/** @deprecated Official 2.1.153 renamed to registerProcessIOErrorHandlers */
export function registerProcessOutputErrorHandlers(
  onGone?: (stream: 'stdin' | 'stdout', code: string) => void,
): void {
  registerProcessIOErrorHandlers(onGone)
}

const STREAM_CLOSED = Symbol('stream-closed')

/** Official 2.1.153 `uB8`: race stdin iterator against close so stream-json exits. */
export async function* iterateStreamUntilClose(
  stream: NodeJS.ReadStream,
): AsyncGenerator<string> {
  if (stream.readableEnded || stream.destroyed) return
  let closed = false
  let resolveClose: (() => void) | null = null
  const onClose = (): void => {
    closed = true
    resolveClose?.()
  }
  stream.once('close', onClose)
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (!closed) {
      const next = iterator.next()
      next.catch(() => {})
      const closedPromise = new Promise<typeof STREAM_CLOSED>(resolve => {
        resolveClose = () => resolve(STREAM_CLOSED)
      })
      const raced = await Promise.race([next, closedPromise])
      resolveClose = null
      if (raced === STREAM_CLOSED || (raced as IteratorResult<string>).done) {
        return
      }
      yield String((raced as IteratorResult<string>).value)
    }
  } finally {
    stream.off('close', onClose)
    void iterator.return?.().catch(() => {})
  }
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return
  }

  // Note: we don't handle backpressure (write() returning false).
  //
  // We should consider handling the callback to ensure we wait for data to flush.
  stream.write(data /* callback to handle here */)
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data)
}

export function writeToStderr(data: string): void {
  writeOut(process.stderr, data)
}

// Write error to stderr and exit with code 1. Consolidates the
// console.error + process.exit(1) pattern used in entrypoint fast-paths.
export function exitWithError(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(chalk.red(message))
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

// Wait for a stdin-like stream to close, but give up after ms if no data ever
// arrives. First data chunk cancels the timeout — after that, wait for end
// unconditionally (caller's accumulator needs all chunks, not just the first).
// Returns true on timeout, false on end. Used by -p mode to distinguish a
// real pipe producer from an inherited-but-idle parent stdin.
export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    const onEnd = () => done(false)
    const onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: races timeout against stream end/data events
    const peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
