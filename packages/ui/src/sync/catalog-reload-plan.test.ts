import { describe, expect, test } from "bun:test"
import { GLOBAL_CATALOG_SCOPE, planCatalogReload } from "./catalog-reload-plan"

const ACTIVE = "/repo/active"
const OPEN = "/repo/open"
const PREWARMED = "/repo/prewarmed"
const directories = {
  isActive: (directory: string) => directory === ACTIVE,
  hasStore: (directory: string) => directory === ACTIVE || directory === OPEN,
}

describe("planCatalogReload", () => {
  test("a directory nothing has open re-reads nothing", () => {
    expect(planCatalogReload("provider", new Set([PREWARMED]), directories)).toBeNull()
    expect(planCatalogReload("agent", new Set([PREWARMED, "/repo/other"]), directories)).toBeNull()
  })

  test("the active directory refreshes the Settings stores and its own store", () => {
    expect(planCatalogReload("agent", new Set([ACTIVE, PREWARMED]), directories))
      .toEqual({ refreshSettingsStores: true, childStores: [ACTIVE] })
  })

  test("another open directory re-reads only its own store", () => {
    expect(planCatalogReload("provider", new Set([OPEN, PREWARMED]), directories))
      .toEqual({ refreshSettingsStores: false, childStores: [OPEN] })
  })

  test("a global announcement and the project list reach everything", () => {
    expect(planCatalogReload("config", new Set([GLOBAL_CATALOG_SCOPE]), directories))
      .toEqual({ refreshSettingsStores: true, childStores: "all" })
    expect(planCatalogReload("project", new Set([PREWARMED]), directories))
      .toEqual({ refreshSettingsStores: true, childStores: "all" })
  })
})
