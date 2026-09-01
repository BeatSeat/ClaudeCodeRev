const TRACKED = new Set([1000, 1002, 1003, 1004, 1006, 2004, 2031])
const CSI = /\x1b\[\?([\d;]+)([hl])/g

/** Official `Xy$`. */
export function createDecModes(): {
  feed: (chunk: string, onChange?: (mode: number) => void) => boolean
  seed: (modes: number[]) => void
  snapshot: () => number[]
} {
  const enabled = new Set<number>()
  let tail = ''
  return {
    feed(q, onChange) {
      const _ = tail ? tail + q : q
      CSI.lastIndex = 0
      let z: RegExpExecArray | null
      let A = 0
      let Y = false
      while ((z = CSI.exec(_)) !== null) {
        const M = z[2] === 'h'
        for (const j of z[1]!.split(';')) {
          const w = Number(j)
          if (TRACKED.has(w) && enabled.has(w) !== M) {
            if (M) {
              enabled.add(w)
              onChange?.(w)
            } else enabled.delete(w)
            Y = true
          }
        }
        A = z.index + z[0].length
      }
      const O = _.slice(Math.max(A, _.length - 16))
      const f = O.lastIndexOf('\x1B')
      tail =
        f >= 0 && /^\x1b(\[(\?[\d;]*)?)?$/.test(O.slice(f)) ? O.slice(f) : ''
      return Y
    },
    seed(q) {
      for (const K of q) if (TRACKED.has(K)) enabled.add(K)
    },
    snapshot() {
      return [...enabled]
    },
  }
}
