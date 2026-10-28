import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoggingChannelServer, type IServerChannel } from "@zcode/rpc";
import { createCoreDiagnosticLog } from "../src/server-core/core.js";
import { createCoreRpcLogger } from "../src/server-core/http.js";

const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "zcode-core-diagnostics-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core operational diagnostics", () => {
  it("persists only safe metadata and flushes the asynchronous write queue", async () => {
    const root = await directory();
    const diagnostics = createCoreDiagnosticLog(root, 7);
    const secret = "synthetic-password-prompt-and-cookie";
    diagnostics.logger.warn(undefined, secret, {
      event: "application.host.call",
      method: "conversationAuthorize",
      outcome: "failed",
      durationMs: 12.345,
      input: { cookie: secret },
      error: new Error(secret),
      stack: secret,
      result: { token: secret },
      correlationId: "synthetic-request",
      commandId: "11d91ca2-1d75-447f-a978-b7dd336db381",
      sessionId: secret,
    });
    diagnostics.logger.info(undefined, secret, { event: secret, method: secret });
    diagnostics.logger.debug(undefined, secret, { event: "application.host.call", method: secret });
    expect(await diagnostics.flush()).toEqual({ flushed: true, dropped: 0, writeFailures: 0 });
    const text = await readFile(join(root, "core.log"), "utf8");
    expect(text).not.toContain(secret);
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({
      timestamp: expect.any(String),
      level: "warn",
      generation: 7,
      pid: process.pid,
      event: "application.host.call",
      method: "conversationAuthorize",
      outcome: "failed",
      durationMs: 12.3,
      correlationId: "synthetic-request",
      commandId: "11d91ca2-1d75-447f-a978-b7dd336db381",
    });
    if (process.platform !== "win32")
      expect((await stat(join(root, "core.log"))).mode & 0o777).toBe(0o600);
  });

  it("rotates bounded files after closing each append, retaining two older files", async () => {
    const root = await directory();
    const diagnostics = createCoreDiagnosticLog(root, 2, { maxFileBytes: 512 });
    for (let i = 0; i < 20; i++) {
      diagnostics.logger.info(undefined, "call", {
        event: "application.host.call",
        method: "inspect",
        outcome: "completed",
        correlationId: `request-${i}`,
        durationMs: i,
      });
      expect((await diagnostics.flush()).writeFailures).toBe(0);
    }
    expect((await readdir(root)).sort()).toEqual(["core.log", "core.log.1", "core.log.2"]);
    for (const file of await readdir(root))
      expect((await stat(join(root, file))).size).toBeLessThanOrEqual(512);
    expect(await readFile(join(root, "core.log"), "utf8")).toContain("request-19");
    expect(await readFile(join(root, "core.log.2"), "utf8")).not.toContain('request-0"');
  });

  it("bounds bursts and reports dropped entries without holding business calls", async () => {
    const root = await directory();
    const diagnostics = createCoreDiagnosticLog(root, 3, { maxQueuedBytes: 512 });
    for (let i = 0; i < 100; i++)
      diagnostics.logger.warn(undefined, "call", {
        event: "application.host.call",
        method: "inspect",
        outcome: "failed",
        durationMs: 1,
      });
    const result = await diagnostics.flush();
    expect(result.flushed).toBe(true);
    expect(result.dropped).toBeGreaterThan(90);
    expect(result.writeFailures).toBe(0);
    const records = (await readFile(join(root, "core.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.find((row) => row.event === "server.diagnostics.dropped").count).toBe(
      result.dropped,
    );
    expect(records.length).toBeLessThan(5);
  });

  it("contains file IO failure and reports it without rejecting the caller or flush", async () => {
    const root = await directory();
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "synthetic existing file");
    const diagnostics = createCoreDiagnosticLog(blocked, 4);
    expect(() =>
      diagnostics.logger.warn(undefined, "call", {
        event: "application.host.call",
        method: "inspect",
        outcome: "failed",
      }),
    ).not.toThrow();
    expect(await diagnostics.flush()).toEqual({ flushed: true, dropped: 0, writeFailures: 1 });
    expect(await readFile(blocked, "utf8")).toBe("synthetic existing file");
  });

  it("keeps malformed RPC method names out of warnings and debug output", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    createCoreRpcLogger(logger, "web-remote-replayable")(
      "[rpc:call] application-host.invalid\nsynthetic-private-value FAIL (1.0ms)",
      new Error("synthetic-private-error"),
    );
    expect(logger.warn).toHaveBeenCalledWith(undefined, "Server RPC failed", {
      event: "server.rpc.failure",
      outcome: "failed",
      correlationId: expect.any(String),
      clientMode: "web-remote-replayable",
    });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "promotes RPC failure metadata for %s without persisting the exception",
    async (clientMode) => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      let channel!: IServerChannel<string>;
      const wrapped = new LoggingChannelServer<string>(
        {
          registerChannel(_name, value) {
            channel = value;
          },
        },
        createCoreRpcLogger(logger, clientMode),
      );
      const secret = "synthetic-rpc-error-with-authorization";
      wrapped.registerChannel("application-host", {
        async call<T>(_context: string, command: string): Promise<T> {
          if (command === "fail") throw new Error(secret);
          return "ok" as T;
        },
        listen() {
          throw new Error(secret);
        },
      });
      expect(await channel.call("test", "inspect", { secret })).toBe("ok");
      expect(logger.warn).not.toHaveBeenCalled();
      await expect(channel.call("test", "fail", { secret })).rejects.toThrow(secret);
      expect(logger.warn).toHaveBeenCalledWith(
        undefined,
        "Server RPC failed",
        expect.objectContaining({
          event: "server.rpc.failure",
          method: "fail",
          channel: "application-host",
          outcome: "failed",
          durationMs: expect.any(Number),
          clientMode,
        }),
      );
      expect(JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls])).not.toContain(
        secret,
      );
    },
  );
});
