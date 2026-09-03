import { useStartupNotification } from './useStartupNotification.js'

// Official 2.1.162 removed the Sonnet 4.6 / Opus 4.8 one-shot banners
// (`sonnet-46-update`, `opus-pro-update`). Hook stays so call sites compile.
export function useModelMigrationNotifications(): void {
  useStartupNotification(() => null)
}
