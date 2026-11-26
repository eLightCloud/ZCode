import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Supervisor } from "../src/supervisor/supervisor.js";
import { requestControl } from "../src/ipc/controlClient.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { FakeCore, waitForState } from "./fixtures/supervisorFixture.js";

it.each(["blocked", "timeout", "accepted"])(
  "keeps idle-stop %s inside native lifecycle without forced termination",
  async (decision) => {
    const root = await mkdtemp(join(tmpdir(), "idle-"));
    const layout = resolveServerLayout(root);
    const core = new FakeCore();
    const original = core.send.bind(core);
    core.send = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "command" in message &&
        message.command === "shutdown-if-idle"
      ) {
        if (decision === "blocked")
          queueMicrotask(() => core.emit("message", { type: "idle-stop-blocked" }));
        if (decision === "accepted") queueMicrotask(() => core.emit("exit", 0, null));
        return true;
      }
      return original(message);
    };
    const supervisor = new Supervisor({
      layout,
      version: "test",
      coreStopGraceTimeoutMs: 40,
      launcher: {
        launch: (generation) => {
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
    });
    try {
      await supervisor.start();
      await waitForState(supervisor, "ready");
      expect(
        await requestControl(layout.controlEndpoint, { command: "stop-if-idle" }),
      ).toMatchObject({ stopping: true });
      if (decision === "accepted") await waitForState(supervisor, "stopped");
      else if (decision === "timeout") await waitForState(supervisor, "stop-failed");
      else {
        const deadline = Date.now() + 2_000;
        while (
          supervisor.status().lastExitReason !== "idle-stop-blocked" &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(supervisor.status().lastExitReason).toBe("idle-stop-blocked");
        expect(supervisor.status().state).toBe("ready");
      }
      expect(core.killRequested).toBe(false);
    } finally {
      if (decision === "timeout") {
        // state 先更新，失败 Promise 随后结算；等待该次失败后应能显式重试普通 stop。
        await supervisor.stop().catch((error: unknown) => {
          expect(String(error)).toContain("Idle stop was not confirmed");
        });
      }
      await supervisor.stop();
    }
  },
);

it("rejects idle-stop admission while the native task owner reports active work", async () => {
  const root = await mkdtemp(join(tmpdir(), "idle-busy-"));
  const layout = resolveServerLayout(root);
  const core = new FakeCore();
  const supervisor = new Supervisor({
    layout,
    version: "test",
    launcher: {
      launch: (generation) => {
        core.reportReady(generation);
        return core as unknown as ChildProcess;
      },
    },
  });
  try {
    await supervisor.start();
    await waitForState(supervisor, "ready");
    core.emit("message", { type: "task-activity", runningTaskCount: 1 });
    expect(await requestControl(layout.controlEndpoint, { command: "stop-if-idle" })).toMatchObject(
      { stopping: false },
    );
    expect(supervisor.status().state).toBe("ready");
    expect(core.shutdownRequested).toBe(false);
    expect(core.killRequested).toBe(false);
  } finally {
    await supervisor.stop();
  }
});

it("drains an explicit graceful stop without killing or restarting a late writer", async () => {
  const layout = resolveServerLayout(await mkdtemp(join(tmpdir(), "graceful-")));
  const core = new FakeCore();
  core.exitOnShutdown = false;
  const stopped = Promise.withResolvers<void>();
  const supervisor = new Supervisor({
    onStopped: () => stopped.resolve(),
    layout,
    version: "test",
    coreStopGraceTimeoutMs: 5,
    launcher: {
      launch(generation) {
        core.reportReady(generation);
        return core as unknown as ChildProcess;
      },
    },
  });
  try {
    await supervisor.start();
    await waitForState(supervisor, "ready");
    core.emit("message", { type: "task-activity", runningTaskCount: 1 });
    expect(supervisor.status(true).capabilities?.gracefulStop).toBe(true);
    for (let i = 0; i < 2; i++) {
      expect(
        await requestControl(layout.controlEndpoint, { command: "graceful-stop" }),
      ).toMatchObject({ stopping: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(core.shutdownRequested).toBe(true);
    expect(core.killRequested).toBe(false);
    expect(supervisor.status().state).toBe("stopping");
    core.emit("exit", 0, null);
    await waitForState(supervisor, "stopped");
  } finally {
    core.exitOnShutdown = true;
    core.emit("exit", 0, null);
    await stopped.promise;
  }
});
