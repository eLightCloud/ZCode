import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runtimeMaintenanceParamsSchema,
  type LocalRuntimeMaintenance,
  type RuntimeMaintenanceParams,
  type RuntimeMaintenanceResult,
} from "@zcode/shared";
import type { CoreHttpServer } from "./http.js";

export async function readMaintenanceOperation(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error("Invalid maintenance marker");
    const marker: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof marker !== "object" || marker === null || !("operationId" in marker)) {
      throw new Error("Invalid maintenance marker");
    }
    return runtimeMaintenanceParamsSchema.parse({ action: "status", operationId: marker.operationId }).operationId;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export class CoreMaintenance {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly http: CoreHttpServer,
    private readonly lifecycle: LocalRuntimeMaintenance | undefined,
    private readonly busy: () => boolean,
    private operation: string | null,
  ) {}

  handle(input: RuntimeMaintenanceParams): Promise<RuntimeMaintenanceResult> {
    const pending = this.tail.then(() => this.run(runtimeMaintenanceParamsSchema.parse(input)));
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  prepareIdleStop(): Promise<boolean> {
    const pending = this.tail.then(async () => {
      if (this.operation || this.busy() || !this.lifecycle || !this.http.tryBeginIdleShutdown()) return false;
      const operationId = randomUUID();
      try {
        const result = await this.lifecycle({ action: "begin", operationId });
        if (result.state === "held" && result.operationId === operationId) return true;
      } catch { /* 未确认不得停止；只允许准确操作收口后恢复接纳。 */ }
      try {
        const result = await this.lifecycle({ action: "cancel", operationId });
        if (result.state === "released") this.http.resumeAfterMaintenance();
      } catch { /* 释放未知时保留屏障，不能将回收升级为强杀。 */ }
      return false;
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async persist(): Promise<void> {
    const temporary = this.path + "." + randomUUID() + ".tmp";
    if (this.operation) {
      const stream = await open(temporary, "wx", 0o600);
      try {
        await stream.writeFile(JSON.stringify({ operationId: this.operation }));
        await stream.sync();
      } finally { await stream.close(); }
      try { await rename(temporary, this.path); }
      finally { await unlink(temporary).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      }); }
    } else {
      await unlink(this.path).catch(error => { if (error?.code !== "ENOENT") throw error; });
    }
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async run(input: RuntimeMaintenanceParams): Promise<RuntimeMaintenanceResult> {
    const blocked = (reasonCode: "native_activity" | "operation_conflict" | "unconfirmed"):
    RuntimeMaintenanceResult => ({ operationId: this.operation, state: "blocked", reasonCode });
    if (this.operation && this.operation !== input.operationId) return blocked("operation_conflict");
    if (!this.lifecycle) return blocked("unconfirmed");
    if (input.action === "begin" && this.operation === null) {
      if (this.busy() || !this.http.tryBeginIdleShutdown()) return blocked("native_activity");
      this.operation = input.operationId;
    }
    if (this.operation === null) return { operationId: null, state: "released" };
    if (input.action === "cancel") {
      const result = await this.lifecycle(input);
      if (result.state !== "released") return blocked(result.reasonCode ?? "unconfirmed");
      const operation = this.operation;
      this.operation = null;
      try { await this.persist(); }
      catch (error) { this.operation = operation; throw error; }
      this.http.resumeAfterMaintenance();
      return result;
    }
    // 确认落盘后才交付 held；重试不能把之前落盘失败当作成功。
    await this.persist();
    const result = await this.lifecycle(input);
    if (result.state !== "held" || result.operationId !== input.operationId) {
      return blocked(result.reasonCode ?? "unconfirmed");
    }
    return result;
  }
}
