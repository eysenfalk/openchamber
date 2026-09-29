import type { CatalogKind } from "@/lib/opencode/events"

/** Where a catalog changed: an OpenCode location's directory, or `"global"`. */
export const GLOBAL_CATALOG_SCOPE = "global"

export type CatalogReloadPlan = {
  /** Re-read the Settings and composer stores, which follow the active directory. */
  refreshSettingsStores: boolean
  /** Directory stores whose copy of the slice is re-read. */
  childStores: "all" | string[]
}

/**
 * Decides what one settled burst of catalog announcements re-reads.
 *
 * OpenCode announces a change once for every directory it serves, which
 * includes directories the user has since left, so an announcement for a
 * directory nothing has open re-reads nothing: its cached config snapshot is
 * revalidated when it is opened. A `"global"` announcement and the project
 * list still reach everything. Returns `null` when there is nothing to read.
 */
export function planCatalogReload(
  kind: CatalogKind,
  scopes: ReadonlySet<string>,
  directories: { isActive: (directory: string) => boolean; hasStore: (directory: string) => boolean },
): CatalogReloadPlan | null {
  if (kind === "project" || scopes.has(GLOBAL_CATALOG_SCOPE)) return { refreshSettingsStores: true, childStores: "all" }
  const scoped = [...scopes]
  const refreshSettingsStores = scoped.some(directories.isActive)
  const childStores = scoped.filter(directories.hasStore)
  if (!refreshSettingsStores && childStores.length === 0) return null
  return { refreshSettingsStores, childStores }
}
