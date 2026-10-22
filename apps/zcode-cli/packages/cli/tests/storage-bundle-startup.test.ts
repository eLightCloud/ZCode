import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("prepares storage from the shipped CommonJS bundle inside a Host Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-storage-bundle-"));
  const worker = new Worker(fileURLToPath(new URL("../dist/zcode.cjs", import.meta.url)), {
    argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", root],
    env: {
      HOME: root,
      USERPROFILE: root,
      PATH: process.env.PATH,
      ZCODE_STORAGE_DIR: root,
      ZCODE_DATA_BASE_DIR: root,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdin: true,
    stdout: true,
    stderr: true,
    execArgv: [],
  });
  const lines = createInterface({ input: worker.stdout! });
  let prepared = false;
  const methods: string[] = [];
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    methods.push(frame.method);
    if (frame.method === "startup/storagePath")
      worker.stdin!.write(
        JSON.stringify({ method: "startup/storagePathReady", reuse: false }) + "\n",
      );
    if (frame.method === "startup/storagePrepared") {
      prepared = true;
      worker.stdin!.end();
    }
  });
  worker.stderr!.resume();
  try {
    const code = await new Promise<number>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    expect(code).toBe(0);
    expect(prepared).toBe(true);
    expect(methods[0]).toBe("startup/storagePath");
  } finally {
    await worker.terminate();
    lines.close();
    await rm(root, { recursive: true, force: true });
  }
});
