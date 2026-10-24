import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RuntimeMaintenanceParams } from "@zcode/shared";
import { createLocalRuntimeMaintenance } from "../src/zcode-agent/localRuntimeMaintenance.js";
import type { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";
import type { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

function fixture(unsupported = false) {
  let held: string | null = null;
  let acquisition: string | null = null;
  const request = vi.fn(async (_method: string, input: RuntimeMaintenanceParams) => {
    if (unsupported) throw new Error("method not found");
    if (input.action === "begin") held = input.operationId;
    if (input.action === "cancel") held = null;
    return { state: held ? ("held" as const) : ("released" as const), operationId: held };
  });
  const client = {
    request,
    isDisposed: false,
    storageStartup: { isWaiting: false },
    pendingOperationRequestCount: 0,
  } as unknown as ZCodeProtocolClient;
  const manager = {
    holdLocalMaintenance: vi.fn((id: string) => {
      acquisition = id;
      return true;
    }),
    releaseLocalMaintenance: vi.fn(() => {
      acquisition = null;
      return true;
    }),
    listManagedProcesses: () => [{ client }],
  } as unknown as ZCodeAgentProcessManager;
  return { client, request, manager, acquisition: () => acquisition };
}

it("only releases exact local lifecycle ownership after runtime acknowledgements", async () => {
  const f = fixture();
  const lifecycle = createLocalRuntimeMaintenance([f.manager], () => false);
  const operationId = randomUUID();
  expect(await lifecycle({ action: "begin", operationId })).toEqual({ operationId, state: "held" });
  expect(f.acquisition()).toBe(operationId);
  expect(await lifecycle({ action: "cancel", operationId: randomUUID() })).toMatchObject({
    state: "blocked",
    reasonCode: "operation_conflict",
  });
  expect(f.manager.releaseLocalMaintenance).not.toHaveBeenCalled();
  expect(await lifecycle({ action: "cancel", operationId })).toEqual({
    operationId: null,
    state: "released",
  });
  expect(f.acquisition()).toBeNull();
});

it("an older CLI is probed without a mutating begin and acquisition can be cancelled", async () => {
  const f = fixture(true);
  const lifecycle = createLocalRuntimeMaintenance([f.manager], () => false);
  const operationId = randomUUID();
  expect(await lifecycle({ action: "begin", operationId })).toMatchObject({
    state: "blocked",
    reasonCode: "unconfirmed",
  });
  expect(f.request.mock.calls.every(([, input]) => input.action === "status")).toBe(true);
  expect(await lifecycle({ action: "cancel", operationId })).toEqual({
    operationId: null,
    state: "released",
  });
  expect(f.acquisition()).toBeNull();
});

it("unsettled workspace startup or protocol operation never becomes a held receipt", async () => {
  const f = fixture();
  const operationId = randomUUID();
  expect(
    await createLocalRuntimeMaintenance([f.manager], () => true)({ action: "begin", operationId }),
  ).toMatchObject({ state: "blocked", reasonCode: "native_activity" });
  expect(f.manager.holdLocalMaintenance).not.toHaveBeenCalled();
  Object.assign(f.client, { pendingOperationRequestCount: 1 });
  const lifecycle = createLocalRuntimeMaintenance([f.manager], () => false);
  expect(await lifecycle({ action: "begin", operationId })).toMatchObject({
    state: "blocked",
    reasonCode: "native_activity",
  });
  expect(f.request).not.toHaveBeenCalled();
});

it("an unconfirmed cancellation keeps acquisition closed", async () => {
  const f = fixture();
  const operationId = randomUUID();
  const lifecycle = createLocalRuntimeMaintenance([f.manager], () => false);
  await lifecycle({ action: "begin", operationId });
  f.request.mockRejectedValueOnce(new Error("synthetic unknown response"));
  expect(await lifecycle({ action: "cancel", operationId })).toMatchObject({
    state: "blocked",
    reasonCode: "unconfirmed",
  });
  expect(f.acquisition()).toBe(operationId);
  expect(f.manager.releaseLocalMaintenance).not.toHaveBeenCalled();
});

it("a runtime retiring during its acknowledgement is not positive idle evidence", async () => {
  const f = fixture();
  const operationId = randomUUID();
  const lifecycle = createLocalRuntimeMaintenance([f.manager], () => false);
  f.request.mockImplementation(async (_method, input) => {
    if (input.action === "begin") {
      vi.mocked(f.manager.holdLocalMaintenance).mockReturnValue(false);
      return { state: "held", operationId };
    }
    return { state: "released", operationId: null };
  });
  expect(await lifecycle({ action: "begin", operationId })).toMatchObject({
    state: "blocked",
    reasonCode: "unconfirmed",
  });
  expect(await lifecycle({ action: "cancel", operationId })).toMatchObject({ state: "blocked" });
  expect(f.manager.releaseLocalMaintenance).not.toHaveBeenCalled();
});
