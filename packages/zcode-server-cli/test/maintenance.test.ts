import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CoreMaintenance, readMaintenanceOperation } from "../src/server-core/maintenance.js";
import type { CoreHttpServer } from "../src/server-core/http.js";
import type { LocalRuntimeMaintenance } from "@zcode/shared";

async function fixture(run: (path: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "zcode-maintenance-"));
  try { await run(join(folder, "operation.json")); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

it("retains Core admission and durable operation until exact release", async () => fixture(async path => {
  const operationId = randomUUID();
  const http = { tryBeginIdleShutdown: vi.fn(() => true), resumeAfterMaintenance: vi.fn() } as unknown as CoreHttpServer;
  const lifecycle: LocalRuntimeMaintenance = async input => ({ state: input.action === "cancel" ? "released" : "held",
    operationId: input.action === "cancel" ? null : input.operationId });
  const owner = new CoreMaintenance(path, http, lifecycle, () => false, null);
  expect(await owner.handle({ action: "begin", operationId })).toEqual({ state: "held", operationId });
  expect(await readMaintenanceOperation(path)).toBe(operationId);
  expect(http.tryBeginIdleShutdown).toHaveBeenCalledOnce();
  expect(await owner.handle({ action: "cancel", operationId: randomUUID() }))
    .toMatchObject({ state: "blocked", reasonCode: "operation_conflict" });
  expect(http.resumeAfterMaintenance).not.toHaveBeenCalled();
  // A restarted Core uses initiallyPaused and cannot silently discard the durable operation.
  const restarted = new CoreMaintenance(path, http, lifecycle, () => false, await readMaintenanceOperation(path));
  expect((await restarted.handle({ action: "begin", operationId })).state).toBe("held");
  expect(http.tryBeginIdleShutdown).toHaveBeenCalledOnce();
  expect(await restarted.handle({ action: "cancel", operationId })).toEqual({ operationId: null, state: "released" });
  expect(await readMaintenanceOperation(path)).toBeNull();
  expect(http.resumeAfterMaintenance).toHaveBeenCalledOnce();
}));

it("busy or automation never pauses HTTP or invokes the runtime owner", async () => fixture(async path => {
  const http = { tryBeginIdleShutdown: vi.fn(() => true), resumeAfterMaintenance: vi.fn() } as unknown as CoreHttpServer;
  const lifecycle = vi.fn<LocalRuntimeMaintenance>();
  const owner = new CoreMaintenance(path, http, lifecycle, () => true, null);
  expect(await owner.handle({ action: "begin", operationId: randomUUID() }))
    .toMatchObject({ state: "blocked", reasonCode: "native_activity" });
  expect(http.tryBeginIdleShutdown).not.toHaveBeenCalled();
  expect(lifecycle).not.toHaveBeenCalled();
  expect(await readMaintenanceOperation(path)).toBeNull();
}));

it("unknown runtime retirement stays fenced and cannot become a successful cancellation", async () => fixture(async path => {
  const operationId = randomUUID();
  const http = { tryBeginIdleShutdown: vi.fn(() => true), resumeAfterMaintenance: vi.fn() } as unknown as CoreHttpServer;
  const lifecycle: LocalRuntimeMaintenance = async () => ({ state: "blocked", operationId, reasonCode: "unconfirmed" });
  const owner = new CoreMaintenance(path, http, lifecycle, () => false, null);
  expect((await owner.handle({ action: "begin", operationId })).state).toBe("blocked");
  expect((await owner.handle({ action: "cancel", operationId })).state).toBe("blocked");
  expect(await readMaintenanceOperation(path)).toBe(operationId);
  expect(http.resumeAfterMaintenance).not.toHaveBeenCalled();
}));
