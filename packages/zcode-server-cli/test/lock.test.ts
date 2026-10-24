import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataRootLock } from "../src/runtime/lock.js";

// 超出常见平台 pid 上限的值：process.kill(pid, 0) 必然 ESRCH，模拟已死的持锁进程。
const DEAD_PID = 2 ** 30;

describe("DataRootLock", () => {
  it("recovers a stale lock left behind by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-stale-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({ protocol: "kernel-sqlite-v1", pid: DEAD_PID, acquiredAt: 0 })}\n`,
      "utf8",
    );

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("recovers a corrupted lock file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-corrupt-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, "not-json", "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    await lock.release();
  });

  it("refuses to steal the lock from a live process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-live-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    const holder = new DataRootLock(lockFile);
    await holder.acquire();
    try {
      await expect(new DataRootLock(lockFile).acquire()).rejects.toThrow(/already running/);
    } finally {
      await holder.release();
    }
  });

  it("reports missing, stale, active and malformed lock owners without mutating the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-inspect-"));
    const lockFile = join(root, "run", "server.lock");
    const lock = new DataRootLock(lockFile);

    await expect(lock.inspect()).resolves.toMatchObject({ state: "missing" });
    await expect(stat(join(root, "run"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({ protocol: "kernel-sqlite-v1", pid: DEAD_PID })}\n`,
      "utf8",
    );
    await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: DEAD_PID });
    await expect(stat(lockFile + ".sqlite")).rejects.toMatchObject({ code: "ENOENT" });
    const holder = new DataRootLock(lockFile);
    await holder.acquire();
    if (process.platform !== "win32")
      expect((await stat(lockFile + ".sqlite")).mode & 0o777).toBe(0o600);
    await expect(lock.inspect()).resolves.toMatchObject({ state: "active", pid: process.pid });
    await holder.release();
    await writeFile(lockFile, "not-json", "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "invalid" });
    await expect(readFile(lockFile, "utf8")).resolves.toBe("not-json");
  });

  it("keeps locks under different data roots isolated (R2-CLI-13)", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "zcode-r2-lock-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "zcode-r2-lock-b-"));
    const lockA = new DataRootLock(join(rootA, "run", "server.lock"));
    const lockB = new DataRootLock(join(rootB, "run", "server.lock"));
    await lockA.acquire();
    await lockB.acquire();
    await lockA.release();
    await lockB.release();
    // 释放后可重新获取。
    await lockA.acquire();
    await lockA.release();
  });

  it.skipIf(process.platform === "win32")(
    "does not delete a replacement lock owned by another token during release",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-owner-"));
      const lockFile = join(root, "run", "server.lock");
      const replacement = join(root, "run", "replacement.lock");
      const lock = new DataRootLock(lockFile);
      await lock.acquire();
      await writeFile(
        replacement,
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          ownerToken: "replacement-owner",
        })}\n`,
        "utf8",
      );
      await rename(replacement, lockFile);

      await lock.release();

      expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({
        ownerToken: "replacement-owner",
      });
    },
  );

  it("allows only one real process to claim the same stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-race-"));
    const lockFile = join(root, "server.lock");
    const barrierFile = join(root, "go");
    const resultsFile = join(root, "results");
    const readyDir = join(root, "ready");
    await mkdir(readyDir);
    await writeFile(
      lockFile,
      `${JSON.stringify({ protocol: "kernel-sqlite-v1", pid: DEAD_PID, acquiredAt: 0 })}\n`,
      "utf8",
    );
    // 根目录 Vitest 与 package 脚本的 cwd 不同，不能用 cwd 推导源码路径，否则子进程会导入不存在的 root/src/runtime/lock.ts。
    const moduleUrl = new URL("../src/runtime/lock.ts", import.meta.url).href;
    const childProgram = `
      import { access, appendFile, readFile, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      const { DataRootLock } = await import(process.env.ZCODE_TEST_LOCK_MODULE);
      const results = process.env.ZCODE_TEST_LOCK_RESULTS;
      const losers = Number(process.env.ZCODE_TEST_LOCK_LOSERS);
      const countLocked = async () => {
        const raw = await readFile(results, "utf8").catch(() => "");
        return raw.split("\\n").filter((line) => line.startsWith("locked ")).length;
      };
      await writeFile(process.env.ZCODE_TEST_LOCK_READY, "ready\\n");
      while (true) { try { await access(process.env.ZCODE_TEST_LOCK_BARRIER); break; } catch { await delay(5); } }
      const lock = new DataRootLock(process.env.ZCODE_TEST_LOCK_FILE);
      try {
        await lock.acquire();
        await appendFile(results, "success " + process.env.ZCODE_TEST_LOCK_CHILD + "\\n");
        // owner 必须持锁到所有竞争者都放弃为止：固定时长会在机器负载高时先于对方的重试
        // 窗口结束，让慢的竞争者在释放后再次 acquire 成功，出现多个 success 的假失败。
        const holdDeadline = Date.now() + 20_000;
        while (Date.now() < holdDeadline && (await countLocked()) < losers) await delay(10);
        await lock.release();
      } catch {
        await appendFile(results, "locked " + process.env.ZCODE_TEST_LOCK_CHILD + "\\n");
      }
    `;
    const childCount = 8;
    const children = Array.from(
      { length: childCount },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "--eval", childProgram],
            {
              env: {
                ...process.env,
                ZCODE_TEST_LOCK_MODULE: moduleUrl,
                ZCODE_TEST_LOCK_BARRIER: barrierFile,
                ZCODE_TEST_LOCK_FILE: lockFile,
                ZCODE_TEST_LOCK_READY: join(readyDir, String(index)),
                ZCODE_TEST_LOCK_RESULTS: resultsFile,
                ZCODE_TEST_LOCK_LOSERS: String(childCount - 1),
                ZCODE_TEST_LOCK_CHILD: String(index),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let childError = "";
          child.stderr.on("data", (chunk) => {
            childError += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(childError || `lock child exited ${code}`)),
          );
        }),
    );
    // 先等待所有子进程进入 barrier；只按固定时间放行会让慢启动的子进程在首个 owner
    // 释放后再次成功获取锁，导致“一个 success”断言随机出现多个 success。
    const readyDeadline = Date.now() + 20_000;
    let allChildrenReady = false;
    while (Date.now() < readyDeadline) {
      if ((await readdir(readyDir)).length === children.length) {
        allChildrenReady = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(barrierFile, "go", "utf8");
    await Promise.all(children);
    const results = (await readFile(resultsFile, "utf8")).trim().split("\n");
    expect(allChildrenReady).toBe(true);
    expect(results.filter((result) => result.startsWith("success "))).toHaveLength(1);
    expect(results.filter((result) => result.startsWith("locked "))).toHaveLength(childCount - 1);
  }, 30_000);
});

it("recovers reused PID metadata and an old recovery gate without deleting the stable guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pid-reuse-"));
  const path = join(root, "server.lock");
  await writeFile(
    path,
    JSON.stringify({ protocol: "kernel-sqlite-v1", pid: process.pid, acquiredAt: 0 }),
  );
  await writeFile(path + ".recovery", JSON.stringify({ pid: process.pid, acquiredAt: 0 }));
  const lock = new DataRootLock(path);
  await expect(lock.inspect()).resolves.toMatchObject({ state: "stale" });
  await lock.acquire();
  await lock.release();
  expect(await readFile(path + ".sqlite")).toBeDefined();
  await lock.acquire();
  await lock.release();
});

it.each(["missing", "corrupt"])(
  "does not lose active ownership when metadata is %s",
  async (kind) => {
    const { rm } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-metadata-"));
    const path = join(root, "server.lock");
    const holder = new DataRootLock(path);
    await holder.acquire();
    try {
      if (kind === "missing") await rm(path);
      else await writeFile(path, "broken");
      await expect(new DataRootLock(path).inspect()).resolves.toMatchObject({ state: "active" });
      await expect(new DataRootLock(path).acquire()).rejects.toThrow(/already running/);
    } finally {
      await holder.release();
    }
  },
);

it("refuses legacy PID protocol until its owner performs an offline migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-lock-legacy-"));
  const path = join(root, "server.lock");
  await writeFile(path, JSON.stringify({ pid: process.pid, acquiredAt: 0 }));
  await expect(new DataRootLock(path).acquire()).rejects.toThrow(/offline migration/);
  expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
});

it.skipIf(process.platform === "win32")(
  "recovers after a real holder is killed without running release",
  async () => {
    const { once } = await import("node:events");
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-killed-"));
    const path = join(root, "server.lock");
    const moduleUrl = new URL("../src/runtime/lock.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
    const { DataRootLock } = await import(${JSON.stringify(moduleUrl)});
    const lock = new DataRootLock(process.env.ZCODE_TEST_LOCK_FILE);
    await lock.acquire(); process.send('held');
  `,
      ],
      {
        env: { ...process.env, ZCODE_TEST_LOCK_FILE: path },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    try {
      await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error("Holder exited before acquiring");
        }),
      ]);
      await expect(new DataRootLock(path).acquire()).rejects.toThrow(/already running/);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const replacement = new DataRootLock(path);
      await replacement.acquire();
      await replacement.release();
    } finally {
      child.kill("SIGKILL");
    }
  },
);

it("refuses uninstall while an orphan Core still owns its writer guard", async () => {
  const { acquireUninstallLock } = await import("../src/runtime/uninstallGuard.js");
  const { resolveServerLayout } = await import("../src/runtime/paths.js");
  const root = await mkdtemp(join(tmpdir(), "zcode-writer-drain-"));
  const layout = resolveServerLayout(root);
  const writer = new DataRootLock(join(layout.runDir, "core.lock"));
  await writer.acquire();
  try {
    await expect(acquireUninstallLock(layout)).rejects.toThrow(/already running/);
    await expect(new DataRootLock(join(layout.runDir, "core.lock")).acquire()).rejects.toThrow(
      /already running/,
    );
  } finally {
    await writer.release();
  }
  const uninstall = await acquireUninstallLock(layout);
  await uninstall.release();
});
