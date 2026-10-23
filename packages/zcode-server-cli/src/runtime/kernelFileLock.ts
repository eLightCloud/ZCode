import { Worker } from "node:worker_threads";

// SQLite 已随固定 Node 发行物交付。只使用 OS 排他锁，不创建表或复制业务状态；
// 同步 SQLite API 留在 worker，异常退出时 OS 自动释放，不能删除/替换此文件。
const program = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
let db;
try {
  db = new DatabaseSync(workerData, { timeout: 0 });
  db.exec('BEGIN EXCLUSIVE');
  parentPort.postMessage({ state: 'acquired' });
  // 活跃 listener 同时保持 worker 与 DatabaseSync 强引用，不能只 ref 空端口。
  parentPort.once('message', () => { db.close(); parentPort.close(); });
} catch (error) {
  if (db) db.close();
  parentPort.postMessage({ state: error.errcode === 5 || error.errcode === 6 ? 'busy' : 'failed', code: error.code, errcode: error.errcode });
  parentPort.close();
}
`;

export async function tryAcquireKernelFileLock(path: string): Promise<Worker | null> {
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(program)}`), { workerData: path, execArgv: [] });
  try {
    const result = await new Promise<{ state: string; code?: string; errcode?: number }>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Server lock worker exited before acquisition")));
      worker.once("message", resolve);
    });
    if (result.state === "acquired") return worker;
    await worker.terminate();
    if (result.state === "busy") return null;
    throw new Error(`Cannot acquire Server kernel lock (code=${result.code ?? "unknown"}, sqlite=${result.errcode ?? "unknown"})`);
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

export async function releaseKernelFileLock(worker: Worker): Promise<void> {
  await worker.terminate();
}
