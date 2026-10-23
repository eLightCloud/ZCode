import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { Supervisor } from "../src/supervisor/supervisor.js";
import { requestControl } from "../src/ipc/controlClient.js";
import { runServerCli } from "../src/cli.js";
import { DataRootLock } from "../src/runtime/lock.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { serverStatusSchema, createStoppedServerStatus } from "../src/contracts.js";

// 仅阻塞已有持久化 facade 的完成时刻，保留真实落盘，不给生产增加测试分支。
const persistence = vi.hoisted(() => ({ beforeWrite: undefined as undefined | (() => Promise<void>) }));
vi.mock("../src/runtime/statusSnapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/statusSnapshot.js")>();
  return { ...actual, createStatusPersister: (...args: Parameters<typeof actual.createStatusPersister>) => {
    const persist = actual.createStatusPersister(...args);
    return async () => { await persistence.beforeWrite?.(); await persist(); };
  } };
});

class ControlledCore extends EventEmitter {
  readonly pid = 42;
  readonly commands: string[] = [];
  killed = false;
  send(message: { command: string }): boolean {
    this.commands.push(message.command);
    if (message.command === "shutdown") queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
  kill(): boolean { this.killed = true; this.emit("exit", null, "SIGKILL"); return true; }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Lifecycle condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-idle-recovery-"));
  const layout = resolveServerLayout(root);
  const cores: ControlledCore[] = [];
  let stopped = 0;
  const supervisor = new Supervisor({ layout, version: "test", coreStopGraceTimeoutMs: 80,
    onStopped: () => { stopped++; },
    launcher: { launch(generation) {
      const core = new ControlledCore(); cores.push(core);
      queueMicrotask(() => core.emit("message", { type: "ready", host: "127.0.0.1", port: 43123, version: "test", generation }));
      return core as unknown as ChildProcess;
    } } });
  await supervisor.start();
  await until(() => supervisor.status().state === "ready");
  return { layout, cores, supervisor, stopped: () => stopped, cleanup: async () => {
    await supervisor.stop(); await rm(root, { recursive: true, force: true });
  } };
}

it.each(["before-reply", "after-reply", "during-persist"])("keeps Core terminal authoritative when exit arrives %s", async (ordering) => {
  const f = await fixture();
  let releaseWrite: (() => void) | undefined;
  try {
    await requestControl(f.layout.controlEndpoint, { command: "stop-if-idle" });
    const core = f.cores[0];
    await until(() => core.commands.includes("shutdown-if-idle"));
    if (ordering === "before-reply") {
      core.emit("exit", 0, null);
      core.emit("message", { type: "idle-stop-blocked" });
      await until(() => f.supervisor.status().state === "stopped");
    } else {
      let entered: Promise<void> | undefined;
      if (ordering === "during-persist") {
        let notifyEntered!: () => void;
        entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
        const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
        persistence.beforeWrite = () => { notifyEntered(); return blocked; };
      }
      core.emit("message", { type: "idle-stop-blocked" });
      if (entered) await entered;
      core.emit("exit", 0, null);
      core.emit("close", 0, null);
      expect(f.supervisor.status()).toMatchObject({ state: "crashed", pid: null, crashBudget: { crashCount: 1 } });
      persistence.beforeWrite = undefined;
      releaseWrite?.();
      await until(() => f.cores.length === 2 && f.supervisor.status().state === "ready");
      expect(f.supervisor.status().crashBudget.crashCount).toBe(1);
      expect(f.supervisor.status().pid).not.toBeNull();
    }
    expect(core.killed).toBe(false);
  } finally { persistence.beforeWrite = undefined; releaseWrite?.(); await f.cleanup(); }
});

it.each(["blocked", "timeout", "accepted"])("does not swallow explicit stop behind idle-stop %s", async (decision) => {
  const f = await fixture();
  try {
    await requestControl(f.layout.controlEndpoint, { command: "stop-if-idle" });
    const core = f.cores[0];
    await until(() => core.commands.includes("shutdown-if-idle"));
    const first = f.supervisor.stop("signal");
    const repeated = f.supervisor.stop("signal");
    if (decision === "blocked") core.emit("message", { type: "idle-stop-blocked" });
    if (decision === "accepted") core.emit("exit", 0, null);
    expect((await first).state).toBe("stopped");
    expect((await repeated).state).toBe("stopped");
    expect(core.commands.filter((command) => command === "shutdown")).toHaveLength(decision === "accepted" ? 0 : 1);
    expect(core.killed).toBe(false);
    expect(f.stopped()).toBe(1);
  } finally { await f.cleanup(); }
});

it("runs ordinary control stop after a rejected idle-stop", async () => {
  const f = await fixture();
  try {
    await requestControl(f.layout.controlEndpoint, { command: "stop-if-idle" });
    await until(() => f.cores[0].commands.includes("shutdown-if-idle"));
    await requestControl(f.layout.controlEndpoint, { command: "stop" });
    f.cores[0].emit("message", { type: "idle-stop-blocked" });
    await until(() => f.supervisor.status().state === "stopped");
    expect(f.cores[0].commands).toEqual(["shutdown-if-idle", "shutdown"]);
  } finally { await f.cleanup(); }
});

it("rejects offline ready as live status while retaining diagnostic status", async () => {
  const f = await fixture();
  const snapshot = await readFile(f.layout.statusFile);
  await f.supervisor.stop();
  await writeFile(f.layout.statusFile, snapshot);
  try {
    let output = "";
    const stdout = { write: (chunk: string) => { output += chunk; } };
    expect(await runServerCli(["status", "--live", "--json", "--server-root", f.layout.serverRoot], { stdout })).toBe(1);
    expect(JSON.parse(output).ok).toBe(false);
    output = "";
    expect(await runServerCli(["status", "--json", "--server-root", f.layout.serverRoot], { stdout })).toBe(0);
    expect(JSON.parse(output).state).toBe("ready");
  } finally { await f.cleanup(); }
});

it.each(["missing", "stopped", "corrupt", "ready", "writer-active"])("validates offline idle-stop idempotency with %s evidence", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-idle-offline-"));
  const layout = resolveServerLayout(root);
  await new ReleaseManager(layout).ensure();
  const writer = new DataRootLock(join(layout.runDir, "core.lock"));
  try {
    if (kind !== "missing") await writeFile(layout.statusFile, kind === "corrupt" ? "broken" : JSON.stringify({
      ...createStoppedServerStatus("test"), state: kind === "ready" ? "ready" : "stopped",
    }));
    if (kind === "writer-active") await writer.acquire();
    const output: string[] = [];
    const result = await runServerCli(["stop", "--if-idle", "--json", "--server-root", root], { stdout: { write: (chunk) => { output.push(chunk); } } });
    expect(result).toBe(kind === "missing" || kind === "stopped" ? 0 : 1);
    if (kind === "writer-active") expect((await writer.inspect()).state).toBe("active");
  } finally { await writer.release(); await rm(root, { recursive: true, force: true }); }
});


it("keeps v1 strict readers compatible unless capabilities are explicitly requested", async () => {
  const f = await fixture();
  const oldReader = serverStatusSchema.omit({ capabilities: true }).strict();
  try {
    const normal = await requestControl(f.layout.controlEndpoint, { command: "status" });
    expect(oldReader.parse(normal).state).toBe("ready");
    expect(normal).not.toHaveProperty("capabilities");
    const live = await requestControl(f.layout.controlEndpoint, { command: "status", includeCapabilities: true });
    expect(live).toHaveProperty("capabilities.liveStatus", true);
    expect(oldReader.safeParse(live).success).toBe(false);
    let output = "";
    expect(await runServerCli(["status", "--live", "--json", "--server-root", f.layout.serverRoot], {
      stdout: { write: (chunk) => { output += chunk; } },
    })).toBe(0);
    expect(JSON.parse(output).capabilities.liveStatus).toBe(true);
    await f.supervisor.stop();
    expect(oldReader.parse(JSON.parse(await readFile(f.layout.statusFile, "utf8"))).state).toBe("stopped");
    output = "";
    expect(await runServerCli(["status", "--json", "--server-root", f.layout.serverRoot], {
      stdout: { write: (chunk) => { output += chunk; } },
    })).toBe(0);
    expect(oldReader.parse(JSON.parse(output)).state).toBe("stopped");
  } finally { await f.cleanup(); }
});


it("does not spend crash budget on repeated typed writer wait timeouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-writer-budget-"));
  const cores: ControlledCore[] = [];
  const supervisor = new Supervisor({ layout: resolveServerLayout(root), version: "test", launcher: {
    launch(generation) {
      const core = new ControlledCore(); cores.push(core);
      queueMicrotask(() => {
        if (cores.length <= 6) {
          core.emit("message", { type: "fatal", reason: "writer-lock-timeout", message: "Server writer lock wait timed out" });
          core.emit("exit", 1, null); core.emit("close", 1, null);
        } else core.emit("message", { type: "ready", host: "127.0.0.1", port: 43123, version: "test", generation });
      });
      return core as unknown as ChildProcess;
    },
  } });
  try {
    await supervisor.start();
    const deadline = Date.now() + 12000;
    while (supervisor.status().state !== "ready" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(supervisor.status().state).toBe("ready");
    expect(cores).toHaveLength(7);
    expect(supervisor.status().crashBudget.crashCount).toBe(0);
  } finally { await supervisor.stop(); await rm(root, { recursive: true, force: true }); }
}, 15000);
