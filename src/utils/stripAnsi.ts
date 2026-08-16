import stripAnsiNpm from 'strip-ansi'

const bunStrip =
  typeof Bun !== 'undefined' && typeof Bun.stripANSI === 'function'
    ? Bun.stripANSI
    : null

export default function stripAnsi(input: string): string {
  return (bunStrip ?? stripAnsiNpm)(input)
}
