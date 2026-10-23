import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { requestControl } from "../src/ipc/controlClient.js";
import { DataRootLock } from "../src/runtime/lock.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { Supervisor } from "../src/supervisor/supervisor.js";
import type { ServerStatus } from "../src/contracts.js";

const coreEntry = fileURLToPath(new URL("../src/server-core/entry.ts", import.meta.url));
const supervisorModule = new URL("../src/supervisor/supervisor.ts", import.meta.url).href;
const config = fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url));
async function until<T>(read: () => T | Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (accepted(value)) return value;
    if (Date.now() > deadline) throw new Error("Real Core lifecycle timed out");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

it.skipIf(process.platform === "win32")("waits for a real orphan Core drain before opening the original data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-real-drain-"));
  const layout = resolveServerLayout(join(root, "server"));
  const env = { ...process.env, ZCODE_SERVER_ROOT: layout.serverRoot, ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config, ZCODE_SERVER_PORT: "", ZCODE_SERVER_AUTOMATION_ENABLED: "0" };
  const launcher = () => fork(coreEntry, ["1"], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const program = `
    import {fork} from 'node:child_process';
    const {Supervisor}=await import(${JSON.stringify(supervisorModule)});
    const s=new Supervisor({layout:${JSON.stringify(layout)}, version:'test',launcher:{launch:g=>fork(${JSON.stringify(coreEntry)},[String(g)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']})}});
    await s.start();
  `;
  const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], { env, stdio: "ignore" });
  const parentExit = once(parent, "exit");
  let socket: Socket | undefined;
  let replacement: Supervisor | undefined;
  let oldPid: number | null = null;
  try {
    const old = await until(async () => {
      try { return await requestControl(layout.controlEndpoint, { command: "status" }, 200) as ServerStatus; }
      catch { return undefined; }
    }, (value) => value?.state === "ready");
    if (!old?.port || !old.pid) throw new Error("Original real Core is not ready");
    oldPid = old.pid;
    const oldInfo = await (await fetch(`http://127.0.0.1:${old.port}/api/server-info`)).json();
    socket = connect(old.port, "127.0.0.1");
    await once(socket, "connect");
    // 未完成的真实 HTTP 请求让 server.close 等待，构造排空而不注入业务延迟开关。
    socket.write("GET /api/server-info HTTP/1.1\r\nHost: localhost\r\n");
    parent.kill("SIGKILL");
    await parentExit;
    const writer = new DataRootLock(join(layout.runDir, "core.lock"));
    expect(await writer.inspect()).toMatchObject({ state: "active", pid: oldPid });
    const launched: ChildProcess[] = [];
    replacement = new Supervisor({ layout, version: "test", launcher: { launch() {
      const child = launcher(); launched.push(child); return child;
    } } });
    await replacement.start();
    await until(() => replacement!.status(), (value) => value.lastExitReason === "writer-lock-busy");
    // 跨过旧实现约 15 秒崩溃预算窗口，真实 HTTP 排空期间不反复 fork。
    await new Promise((resolve) => setTimeout(resolve, 16000));
    expect(launched).toHaveLength(1);
    expect(replacement.status().state).toBe("starting");
    expect(replacement.status().crashBudget.crashCount).toBe(0);
    expect(await writer.inspect()).toMatchObject({ state: "active", pid: oldPid });
    socket.destroy();
    const ready = await until(() => replacement!.status(), (value) => value.state === "ready");
    expect(ready.pid).not.toBe(oldPid);
    expect(ready.crashBudget.crashCount).toBe(0);
    expect(launched).toHaveLength(1);
    expect(await writer.inspect()).toMatchObject({ state: "active", pid: ready.pid });
    const info = await (await fetch(`http://127.0.0.1:${ready.port}/api/server-info`)).json();
    expect(info.serverId).toBe(oldInfo.serverId);
  } finally {
    socket?.destroy();
    if (replacement) await replacement.stop();
    parent.kill("SIGKILL");
    if (oldPid) { try { process.kill(oldPid, "SIGKILL"); } catch { /* 已退出 */ } }
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it("stops a real Core while it waits for another writer, without stealing the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-writer-stop-"));
  const layout = resolveServerLayout(join(root, "server"));
  const writer = new DataRootLock(join(layout.runDir, "core.lock"));
  await writer.acquire();
  let child: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  const supervisor = new Supervisor({ layout, version: "test", launcher: { launch(generation) {
    child = fork(coreEntry, [String(generation)], { execArgv: ["--import", "tsx"], env: {
      ...process.env, ZCODE_SERVER_ROOT: layout.serverRoot, ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config,
    }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    exited = once(child, "exit");
    return child;
  } } });
  try {
    await supervisor.start();
    await until(() => supervisor.status(), (value) => value.lastExitReason === "writer-lock-busy");
    expect((await supervisor.stop("signal")).state).toBe("stopped");
    expect(await exited).toEqual([0, null]);
    expect(await writer.inspect()).toMatchObject({ state: "active", pid: process.pid });
    expect(supervisor.status().crashBudget.crashCount).toBe(0);
  } finally {
    await supervisor.stop(); child?.kill("SIGKILL"); await writer.release();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("bounds writer wait and supports cancellation without retaining a contender", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-writer-timeout-"));
  const path = join(root, "core.lock");
  const holder = new DataRootLock(path);
  await holder.acquire();
  try {
    await expect(new DataRootLock(path).acquire({ waitMs: 40 })).rejects.toThrow("writer lock wait timed out");
    const controller = new AbortController();
    const waiting = new DataRootLock(path).acquire({ waitMs: 10000, signal: controller.signal,
      onBlocked: () => controller.abort() });
    await expect(waiting).rejects.toThrow();
    expect(await holder.inspect()).toMatchObject({ state: "active", pid: process.pid });
  } finally { await holder.release(); await rm(root, { recursive: true, force: true }); }
});
