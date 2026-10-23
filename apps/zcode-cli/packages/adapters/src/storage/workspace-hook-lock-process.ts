import { readFile } from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";

import { execFile } from "node:child_process";

import { promisify } from "node:util";

import { uptime } from "node:os";

export const PROC_CLOCK_TICKS_PER_SECOND = 100;

export const execFileAsync = promisify(execFile);

export interface LockOwnerMetadata {
  pid: number;
  token: string;
  /** 进程实例启动时间（墙钟 ms）；上一版锁格式无此字段（undefined）。 */
  startTime?: number;
}

export async function defaultWriteLockOwnerMetadata(
  handle: FileHandle,
  content: string,
): Promise<void> {
  await handle.writeFile(content, "utf8");
}

/** 本进程启动时间的墙钟毫秒（惰性缓存：进程生命周期内不变）。 */
export let ownStartTimeMs: number | undefined;

export function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

/**
 * 查询指定 pid 的当前进程实例启动时间（墙钟毫秒）；无法确定时返回 null。
 * 用于 stale 回收时区分「原 owner 实例仍存活」与「pid 已被复用给无关进程」
 * （裸 pid 只标识进程表槽位，不具备跨时间唯一性）。
 * - linux: /proc/<pid>/stat 字段 22（boot 后 ticks）
 * - darwin: ps -o lstart=
 * - win32: powershell Get-Process StartTime（成本较高，但只在超龄回收路径触发）
 * - 失败/不支持 → null，调用方保守视为原 owner 存活（不回收）。
 */
export async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // ')' 之后 token[0] 是 state（字段 3）；starttime 是字段 22 → token[19]。
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}
