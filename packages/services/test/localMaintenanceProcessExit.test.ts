import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";

it("root exit with unconfirmed descendant cleanup cannot grant a maintenance hold", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-owned-exit-"));
  const signal = join(root, "exit-request");
  const reporter = { onSpawn: vi.fn(), onExit: vi.fn() };
  const manager = new ZCodeAgentProcessManager({
    commandResolver: () => ({ command: process.execPath, cwd: root,
      args: ["-e", "const fs=require('node:fs');setInterval(()=>{"
        + "if(fs.existsSync(process.argv[1]))process.exit(0)},10)", signal] }),
    processLifecycleReporter: reporter,
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = await manager.getClient({ workspacePath: root });
  const cleanup = vi.spyOn(client, "disposeAndWait").mockRejectedValue(
    new Error("synthetic descendant cleanup unconfirmed"));
  try {
    await writeFile(signal, "exit");
    await vi.waitFor(() => expect(reporter.onExit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(manager.listManagedProcesses()).toEqual([]);
    expect(manager.holdLocalMaintenance(randomUUID())).toBe(false);
  } finally {
    cleanup.mockRestore();
    await manager.disposeAllAndWait();
    errors.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
