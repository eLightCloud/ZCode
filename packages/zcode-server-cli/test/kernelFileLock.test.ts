import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { releaseKernelFileLock, tryAcquireKernelFileLock } from "../src/runtime/kernelFileLock.js";

it("gracefully closes the real SQLite worker and permits the next owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-worker-release-"));
  const path = join(root, "guard.sqlite");
  const worker = await tryAcquireKernelFileLock(path);
  if (!worker) throw new Error("fixture lock unavailable");
  try {
    const exited = once(worker, "exit");
    await releaseKernelFileLock(worker);
    expect(await exited).toEqual([0]);
    const next = await tryAcquireKernelFileLock(path);
    expect(next).not.toBeNull();
    if (next) await releaseKernelFileLock(next);
  } finally {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds release when an unresponsive worker ignores the close message", async () => {
  const worker = new Worker(
    new URL(
      "data:text/javascript," +
        encodeURIComponent(
          "import {parentPort} from 'node:worker_threads';parentPort.on('message',()=>{});parentPort.postMessage('ready');",
        ),
    ),
    { execArgv: [] },
  );
  await once(worker, "message");
  const started = Date.now();
  try {
    await releaseKernelFileLock(worker);
    expect(worker.threadId).toBe(-1);
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    await worker.terminate();
  }
});
