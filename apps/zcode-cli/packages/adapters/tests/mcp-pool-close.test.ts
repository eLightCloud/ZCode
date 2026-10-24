import type { Logger, McpPort, McpServerConfig } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "../src/mcp/pool.js";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";

const config: McpServerConfig = { type: "stdio", command: "synthetic-worker" };

function resource() {
  const closing = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const status = { status: "connected" as const, toolCount: 0, transport: "stdio" as const };
  const close = vi.fn(async () => {
    closing.resolve();
    await exited.promise;
  });
  const adapter = {
    close,
    connectServer: vi.fn(async () => status),
    status: vi.fn(async () => ({ office: status })),
  } as unknown as McpPort;
  return { adapter, close, closing, exited };
}

describe("MCP pool resource close ownership", () => {
  it("waits for a session worker to exit before cold activation can allocate its successor", async () => {
    const workers: ReturnType<typeof resource>[] = [];
    let live = 0;
    let peak = 0;
    const pool = createMcpConnectionPool({
      createAdapter: () => {
        const worker = resource();
        worker.close.mockImplementation(async () => {
          worker.closing.resolve();
          await worker.exited.promise;
          live -= 1;
        });
        workers.push(worker);
        peak = Math.max(peak, ++live);
        return worker.adapter;
      },
    });
    for (let generation = 0; generation < 2; generation++) {
      const session = pool.acquireLease({ sessionId: "same-persisted-session" });
      await Promise.all(
        ["documents", "pdf", "presentations", "spreadsheets"].map((name) =>
          session.connectServer(name, config),
        ),
      );
      const current = workers.slice(generation * 4);
      let settled = false;
      const closed = session.close().then(() => {
        settled = true;
      });
      await Promise.all(current.map((worker) => worker.closing.promise));
      expect(settled).toBe(false);
      expect(live).toBe(4);
      for (const worker of current.slice(0, 3)) worker.exited.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      current[3]!.exited.resolve();
      await closed;
      expect(live).toBe(0);
    }
    expect(peak).toBe(4);
    await pool.close();
  });

  it.each(["lease-first", "pool-first"])(
    "joins duplicate lease and pool shutdowns (%s) without losing telemetry",
    async (order) => {
      const worker = resource();
      const telemetry = createMcpTelemetryTracker({ idSalt: "synthetic-close", onEvent: vi.fn() });
      const unregister = vi.spyOn(telemetry, "unregisterConnection");
      const pool = createMcpConnectionPool({ createAdapter: () => worker.adapter, telemetry });
      const lease = pool.acquireLease({ sessionId: "synthetic-session" });
      await lease.connectServer("office", config);
      const first = order === "lease-first" ? lease.close() : pool.close();
      await worker.closing.promise;
      let settled = 0;
      const pending = [first, lease.close(), lease.close(), pool.close(), pool.close()].map(
        async (closing) => {
          await closing;
          settled += 1;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(0);
      expect(unregister).not.toHaveBeenCalled();
      worker.exited.resolve();
      await Promise.all(pending);
      expect(settled).toBe(5);
      expect(worker.close).toHaveBeenCalledOnce();
      expect(unregister).toHaveBeenCalledOnce();
      await expect(lease.connectServer("office", config)).rejects.toThrow("lease is closed");
    },
  );

  it("retains workspace references and reuses a worker during its existing grace period", async () => {
    vi.useFakeTimers();
    const worker = resource();
    const createAdapter = vi.fn(() => worker.adapter);
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 30_000 });
    try {
      const shared = { ...config, isolation: "workspace" as const };
      const a = pool.acquireLease();
      const b = pool.acquireLease();
      await a.connectServer("office", shared);
      await b.connectServer("office", shared);
      await a.close();
      expect(worker.close).not.toHaveBeenCalled();
      await b.close();
      expect(worker.close).not.toHaveBeenCalled();
      const c = pool.acquireLease();
      await c.connectServer("office", shared);
      expect(createAdapter).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(worker.close).not.toHaveBeenCalled();
      await c.close();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(worker.close).toHaveBeenCalledOnce();
    } finally {
      worker.exited.resolve();
      await pool.close();
      vi.useRealTimers();
    }
  });

  it.each(["disconnect", "replace"])(
    "preserves grace for %s while the session lease remains open",
    async (action) => {
      vi.useFakeTimers();
      const workers: ReturnType<typeof resource>[] = [];
      const pool = createMcpConnectionPool({
        createAdapter: () => {
          const worker = resource();
          workers.push(worker);
          return worker.adapter;
        },
        idleGraceMs: 30_000,
      });
      try {
        const lease = pool.acquireLease();
        await lease.connectServer("office", config);
        if (action === "disconnect") await lease.disconnectServer("office");
        else await lease.connectServer("office", { ...config, command: "replacement-worker" });
        expect(workers[0]!.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(workers[0]!.close).toHaveBeenCalledOnce();
      } finally {
        for (const worker of workers) worker.exited.resolve();
        await pool.close();
        vi.useRealTimers();
      }
    },
  );

  it("logs a single close failure and unregisters its connection after concurrent shutdowns", async () => {
    const worker = resource();
    const failure = new Error("synthetic-close-failure");
    worker.close.mockRejectedValue(failure);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    } as Logger;
    const telemetry = createMcpTelemetryTracker({ idSalt: "synthetic-close", onEvent: vi.fn() });
    const unregister = vi.spyOn(telemetry, "unregisterConnection");
    const pool = createMcpConnectionPool({
      createAdapter: () => worker.adapter,
      logger,
      telemetry,
    });
    const lease = pool.acquireLease();
    await lease.connectServer("office", config);
    await Promise.all([lease.close(), lease.close(), pool.close(), pool.close()]);
    expect(worker.close).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "MCP pooled connection close failed",
      expect.objectContaining({
        event: "mcp.pool.connection.close.failed",
        mcpServerName: "office",
        error: failure.message,
      }),
    );
  });
});
