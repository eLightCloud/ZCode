import {
  runtimeMaintenanceParamsSchema,
  runtimeMaintenanceResultSchema,
  zcodeProtocolMethods,
  type LocalRuntimeMaintenance,
  type RuntimeMaintenanceParams,
  type RuntimeMaintenanceResult,
} from "@zcode/shared";
import type { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

type Manager = Pick<ZCodeAgentProcessManager,
  "holdLocalMaintenance" | "releaseLocalMaintenance" | "listManagedProcesses">;

/** Local constructor capability, deliberately absent from remotely exposed AgentService methods. */
export function createLocalRuntimeMaintenance(
  managers: readonly Manager[],
  hasWaitingStartup: () => boolean,
): LocalRuntimeMaintenance {
  let active: { operationId: string; clients: Set<ZCodeProtocolClient> } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const blocked = (reasonCode: "native_activity" | "operation_conflict" | "unconfirmed"):
  RuntimeMaintenanceResult => ({ operationId: active?.operationId ?? null, state: "blocked", reasonCode });
  const call = (client: ZCodeProtocolClient, input: RuntimeMaintenanceParams) => client.request(
    zcodeProtocolMethods.processIdleMaintenance, input, runtimeMaintenanceResultSchema,
    { lifecycle: "observation", timeoutMs: 10_000 },
  );
  async function run(raw: RuntimeMaintenanceParams): Promise<RuntimeMaintenanceResult> {
    const input = runtimeMaintenanceParamsSchema.parse(raw);
    if (active && active.operationId !== input.operationId) return blocked("operation_conflict");
    if (input.action === "cancel") {
      if (!active) return { operationId: null, state: "released" };
      if (managers.some(manager => !manager.holdLocalMaintenance(input.operationId))) {
        return blocked("unconfirmed");
      }
      const live = new Set(managers.flatMap(manager => manager.listManagedProcesses()).map(runtime => runtime.client));
      for (const client of active.clients) {
        // Manager guard also accounts for retired-but-not-yet-exited owned processes.
        if (!live.has(client)) continue;
        try {
          if ((await call(client, input)).state !== "released") return blocked("unconfirmed");
        } catch { return blocked("unconfirmed"); }
      }
      if (managers.some(manager => !manager.releaseLocalMaintenance(input.operationId))) {
        return blocked("unconfirmed");
      }
      active = undefined;
      return { operationId: null, state: "released" };
    }
    if (!active && input.action === "status") return { operationId: null, state: "released" };
    if (!active) {
      if (hasWaitingStartup()) return blocked("native_activity");
      const held: Manager[] = [];
      for (const manager of managers) {
        if (!manager.holdLocalMaintenance(input.operationId)) {
          for (const previous of held) previous.releaseLocalMaintenance(input.operationId);
          return blocked("native_activity");
        }
        held.push(manager);
      }
      active = { operationId: input.operationId, clients: new Set() };
    }
    if (hasWaitingStartup() || managers.some(manager => !manager.holdLocalMaintenance(input.operationId))) {
      return blocked("native_activity");
    }
    for (const runtime of managers.flatMap(manager => manager.listManagedProcesses())) {
      const client = runtime.client;
      if (client.isDisposed || client.storageStartup.isWaiting || client.pendingOperationRequestCount) {
        return blocked("native_activity");
      }
      try {
        // Probe an older CLI without mutating it. Only tracked begin attempts require cancellation.
        const status = await call(client, { ...input, action: "status" });
        if (status.state === "blocked") return blocked(status.reasonCode ?? "unconfirmed");
        if (input.action === "begin") {
          active.clients.add(client);
          const result = await call(client, input);
          if (result.state !== "held" || result.operationId !== input.operationId) {
            return blocked(result.reasonCode ?? "unconfirmed");
          }
        } else if (status.state !== "held" || status.operationId !== input.operationId) {
          return blocked("unconfirmed");
        }
      } catch { return blocked("unconfirmed"); }
    }
    // A process can retire while an awaited CLI response is in flight. The
    // manager owns OS-exit/cleanup evidence, including entries no longer in its map.
    if (hasWaitingStartup() || managers.some(manager => !manager.holdLocalMaintenance(input.operationId))) {
      return blocked("unconfirmed");
    }
    return { operationId: input.operationId, state: "held" };
  }
  return (input) => {
    const pending = tail.then(() => run(input));
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
}
