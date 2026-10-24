import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMaintenanceOperation,
  runtimeMaintenanceResultSchema,
} from "../../src/runtime/maintenance-contract/contract.js";
it("never treats an unowned maintenance state as a confirmed barrier", async () => {
  expect(
    runtimeMaintenanceResultSchema.safeParse({ state: "held", operationId: null }).success,
  ).toBe(false);
  expect(
    runtimeMaintenanceResultSchema.safeParse({
      state: "released",
      operationId: "10000000-0000-4000-8000-000000000001",
    }).success,
  ).toBe(false);
  const root = await mkdtemp(join(tmpdir(), "vantage-maintenance-contract-"));
  try {
    expect(await readMaintenanceOperation(join(root, "missing.marker"))).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
