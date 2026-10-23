import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { createServiceLogger } from "@zcode/services/node";
import { releaseKernelFileLock, tryAcquireKernelFileLock } from "./kernelFileLock.js";

const log = createServiceLogger("server-lock");
const protocol = "kernel-sqlite-v1";

export type DataRootLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number | null }
  | { state: "stale"; pid: number }
  | { state: "invalid" }
  | { state: "unreadable"; error: unknown };

export class DataRootLock {
  private worker: Worker | undefined;
  private ownerToken: string | undefined;
  public constructor(private readonly path: string) {}

  public async inspect(): Promise<DataRootLockInspection> {
    const owner = await this.readOwner();
    if (owner.state === "unreadable") return owner;
    // PID 只是诊断。即使旧记录 PID 等于本进程，也必须询问同一固定文件的内核锁。
    if (owner.state === "record" && owner.protocol !== protocol) return { state: "invalid" };
    try {
      // 不因 metadata 写入窗口、损坏或意外删除而把活跃 guard 误报为已释放。
      const guard = await stat(`${this.path}.sqlite`).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (!guard) return owner.state === "record" ? { state: "stale", pid: owner.pid } : owner;
      const worker = await tryAcquireKernelFileLock(`${this.path}.sqlite`);
      if (!worker) return { state: "active", pid: owner.state === "record" ? owner.pid : null };
      await releaseKernelFileLock(worker);
      return owner.state === "record" ? { state: "stale", pid: owner.pid } : owner;
    } catch (error) {
      return { state: "unreadable", error };
    }
  }

  public async acquire(options: { waitMs?: number; signal?: AbortSignal; onBlocked?: () => void } = {}): Promise<void> {
    if (this.worker) throw new Error("Another ZCode Server instance is already running");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const owner = await this.readOwner();
    if (owner.state === "unreadable") throw owner.error;
    // 锁协议迁移不能以新 namespace 内看不到 PID 为由偷旧实例的锁。
    // 部署方须先停止全部旧写入者，再离线清理旧 metadata / recovery。
    if (owner.state === "record" && owner.protocol !== protocol) {
      log.warn("server.lock.acquire", { correlationId: randomUUID(), outcome: "blocked", reasonCode: "legacy_lock_migration_required" });
      throw new Error("Legacy Server lock requires offline migration after all old instances stop");
    }
    // 不用普通 fs.open/close 探测 SQLite 文件：POSIX close 可能释放同进程的 fcntl 锁。
    const started = Date.now();
    const correlationId = randomUUID();
    let worker: Worker | null;
    let reportedBlocked = false;
    while (true) {
      options.signal?.throwIfAborted();
      worker = await tryAcquireKernelFileLock(`${this.path}.sqlite`);
      if (worker) break;
      if (!reportedBlocked) {
        log.warn("server.lock.acquire", { correlationId, outcome: "blocked", reasonCode: "lock_busy" });
        options.onBlocked?.();
        reportedBlocked = true;
      }
      if (Date.now() - started >= (options.waitMs ?? 0)) {
        throw new Error(options.waitMs ? "Server writer lock wait timed out" : "Another ZCode Server instance is already running");
      }
      // 仅已确认的 busy 可等待；权限、损坏及旧协议错误直接失败，不能变成重试掩盖。
      await delay(Math.min(100, (options.waitMs ?? 0) - (Date.now() - started)), undefined, { signal: options.signal });
    }
    if (options.signal?.aborted) {
      await releaseKernelFileLock(worker);
      options.signal.throwIfAborted();
    }
    this.worker = worker;
    // 非预期 worker 错误必须终止宿主，不能继续无锁执行。
    worker.removeAllListeners("error");
    worker.on("error", (error) => { throw error; });
    worker.on("exit", () => {
      if (this.worker === worker) throw new Error("Server kernel lock worker was lost");
    });
    const token = randomUUID();
    this.ownerToken = token;
    try {
      await chmod(`${this.path}.sqlite`, 0o600);
      await writeFile(this.path, `${JSON.stringify({ protocol, pid: process.pid, acquiredAt: Date.now(), ownerToken: token })}\n`, { mode: 0o600 });
      log.info("server.lock.acquire", { correlationId: token, outcome: "succeeded" });
      if (reportedBlocked) log.info("server.lock.wait", { correlationId, outcome: "succeeded", waitedMs: Date.now() - started });
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  public async release(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    const token = this.ownerToken;
    try {
      const owner = await this.readOwner();
      if (owner.state === "record" && owner.ownerToken === token) await rm(this.path, { force: true });
    } finally {
      this.ownerToken = undefined;
      this.worker = undefined;
      await releaseKernelFileLock(worker);
      log.info("server.lock.release", { correlationId: token, outcome: "succeeded" });
    }
  }

  private async readOwner(): Promise<
    | { state: "record"; pid: number; protocol?: string; ownerToken?: string }
    | { state: "missing" | "invalid" }
    | { state: "unreadable"; error: unknown }
  > {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof value !== "object" || value === null || !("pid" in value)
        || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return { state: "invalid" };
      return {
        state: "record", pid: value.pid,
        protocol: "protocol" in value && typeof value.protocol === "string" ? value.protocol : undefined,
        ownerToken: "ownerToken" in value && typeof value.ownerToken === "string" ? value.ownerToken : undefined,
      };
    } catch (error) {
      if (error instanceof SyntaxError) return { state: "invalid" };
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "missing" };
      return { state: "unreadable", error };
    }
  }
}
