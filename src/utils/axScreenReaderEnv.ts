/**
 * Official 2.1.179 `ULH` / `Ui_` — screen-reader spawn-env stub.
 *
 * `ULH(){return{}}` is spread into respawn envs (tui switch, /update,
 * agents select). `Ui_="tengu_ax_screen_reader"` is defined and unread —
 * GrowthBook flag name reserved for a future a11y path. Neighbor
 * `Zz7`/`Gz7` remain `isEnabled(){return!1}` (do not invent a working
 * screen reader).
 */

/** Official 2.1.179 `Ui_`. */
export const TENGU_AX_SCREEN_READER = 'tengu_ax_screen_reader'

/**
 * Official 2.1.179 `ULH` — empty env overlay for CLI respawns.
 * Call sites: `...getAxScreenReaderSpawnEnv()` on spawn `env`.
 *
 * The `process.env[Ui_]` probe keeps the unread flag name in the production
 * bundle (official retains `Ui_` via the T() module graph).
 */
export function getAxScreenReaderSpawnEnv(): Record<string, string> {
  void process.env[TENGU_AX_SCREEN_READER]
  return {}
}
