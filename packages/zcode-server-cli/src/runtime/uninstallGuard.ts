import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DataRootLock, type DataRootLockInspection } from "./lock.js";
import type { ServerLayout } from "./paths.js";

export async function acquireUninstallLock(layout: ServerLayout): Promise<Pick<DataRootLock, "release">> {
  const lock = new DataRootLock(layout.lockFile);
  const inspection = await lock.inspect();
  if (inspection.state === "active") {
    throw new Error(`Cannot uninstall while Server lock is held by pid ${inspection.pid}`);
  }
  if (inspection.state === "invalid" || inspection.state === "unreadable") {
    throw new Error(`Cannot acquire uninstall lock (${describeLockInspection(inspection)})`);
  }
  await lock.acquire();
  const writer = new DataRootLock(join(layout.runDir, "core.lock"));
  try {
    // Supervisor 已死不代表旧 Core 已排空；卸载也必须取得实际 writer 的互斥。
    await writer.acquire();
  } catch (error) {
    await lock.release();
    throw error;
  }
  return { release: async () => {
    try { await writer.release(); } finally { await lock.release(); }
  } };
}

export async function removeRunContentsExceptLock(layout: ServerLayout): Promise<void> {
  const entries = await readdir(layout.runDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "server.lock" || entry.name.endsWith(".lock.sqlite")) continue;
    await rm(join(layout.runDir, entry.name), { recursive: true, force: true });
  }
}

export function describeLockInspection(inspection: DataRootLockInspection): string {
  if (inspection.state === "active") return `active pid ${inspection.pid}`;
  if (inspection.state === "stale") return `stale pid ${inspection.pid}`;
  if (inspection.state === "unreadable") return "lock file is unreadable";
  return `lock state is ${inspection.state}`;
}
