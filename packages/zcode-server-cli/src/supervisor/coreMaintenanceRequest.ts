import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runtimeMaintenanceResultSchema, type RuntimeMaintenanceParams, type RuntimeMaintenanceResult } from "@zcode/shared";

export function requestCoreMaintenance(core: ChildProcess, input: RuntimeMaintenanceParams): Promise<RuntimeMaintenanceResult> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      core.off("message", receive);
      core.off("exit", failed);
      core.off("close", failed);
      core.off("error", failed);
    };
    const failed = () => { cleanup(); reject(new Error("Core maintenance unconfirmed")); };
    const receive = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value)
        || value.type !== "maintenance-result" || !("requestId" in value)
        || value.requestId !== requestId || !("result" in value)) return;
      const parsed = runtimeMaintenanceResultSchema.safeParse(value.result);
      cleanup();
      if (parsed.success) resolve(parsed.data); else reject(new Error("Invalid Core maintenance receipt"));
    };
    const timer = setTimeout(failed, 30_000);
    core.on("message", receive);
    core.once("exit", failed);
    core.once("close", failed);
    core.once("error", failed);
    try { core.send({ command: "maintenance", requestId, input }, error => { if (error) failed(); }); }
    catch { failed(); }
  });
}
