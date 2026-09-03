import { createContext } from 'react'

/**
 * Official 2.1.161 `HoK` / `U78` — ink screen-reader context.
 * Default false; displayName is a unique 161 token.
 */
const AccessibilityContext = createContext(false)
AccessibilityContext.displayName = 'InternalAccessibilityContext'

export default AccessibilityContext
