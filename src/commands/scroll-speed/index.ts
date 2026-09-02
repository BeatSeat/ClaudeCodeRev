/**
 * Official 2.1.139 SL5 — /scroll-speed command metadata.
 * Implementation is lazy-loaded from scroll-speed.tsx.
 */
import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { isJetBrainsIdeTerminal } from './scrollProfile.js'

const scrollSpeed = {
  type: 'local-jsx',
  name: 'scroll-speed',
  description: 'Adjust mouse wheel scroll speed',
  isEnabled: () => {
    // Official SL5: Fq() is fullscreen; kV() attacher caps are unset in
    // this tree, so the JediTerm fallback matches the H==null path.
    if (!isFullscreenEnvEnabled()) return false
    return !isJetBrainsIdeTerminal()
  },
  load: () => import('./scroll-speed.js'),
} satisfies Command

export default scrollSpeed
