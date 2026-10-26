import { EventEmitter } from "node:events";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

export class FakeCore extends EventEmitter {
  public readonly pid = 42;
  public shutdownRequested = false;
  public killRequested = false;
  public exitOnShutdown = true;
  public exitOnKill = true;
  /** 模拟 SIGKILL 已发出但 OS 回收延迟（如 Rosetta/swap 下的不可中断等待）。 */
  public killExitDelayMs: number | undefined;

  public send(message: unknown): boolean {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      this.shutdownRequested = true;
      if (this.exitOnShutdown) queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }

  public kill(): boolean {
    this.killRequested = true;
    if (this.killExitDelayMs !== undefined) {
      setTimeout(() => this.emit("exit", null, "SIGKILL"), this.killExitDelayMs);
    } else if (this.exitOnKill) this.emit("exit", null, "SIGKILL");
    return true;
  }

  public reportReady(generation: number, version = "test", releaseId?: string): void {
    queueMicrotask(() =>
      this.emit("message", {
        type: "ready",
        host: "127.0.0.1",
        port: 43123,
        version,
        ...(releaseId ? { releaseId } : {}),
        generation,
      }),
    );
  }
}

export async function waitForState(supervisor: Supervisor, state: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (supervisor.status().state === state) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Timed out waiting for supervisor state ${state}, got ${supervisor.status().state}`,
  );
}
