import { readFile, rename } from "node:fs/promises";

import { isAbsolute, join, resolve } from "node:path";

import { setTimeout as sleep } from "node:timers/promises";

import type { WorkspaceHookTrustRecord } from "@zcode/contracts";

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export const DEFAULT_STALE_LOCK_MS = 30_000;

export const LOCK_RETRY_MS = 10;

export const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

export const SECURITY_DIRECTORY = "security";

export const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";

// 进程启动时间的比较容差：ps/proc 的秒级精度 + 调度延迟，2s 足以覆盖且不放过复用。
export const LOCK_START_TIME_TOLERANCE_MS = 2_000;

export async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows 杀软/索引器可能短暂占用目标文件，单次 rename 会让已完成
      // fsync 的 Trust mutation 误报失败。仅对已知短暂占用错误做有界异步重试。
      await sleep(delayMs);
    }
  }
}

export function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export async function readUserConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new Error(`Unable to read trusted user config for Workspace Hook Trust store: ${path}`, {
      cause: error,
    });
  }
}

export function resolveTrustedUserPath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  // 安全原因：user config 中的相对 storage.dir 绑定用户目录，不能随 workspace cwd 漂移。
  return resolve(home, path);
}

export function trustKey(record: {
  workspaceIdentity: string;
  hookDeclarationDigest: string;
}): string {
  return `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`;
}

export function recordTimestamp(record: WorkspaceHookTrustRecord): number {
  return Date.parse(record.lastUsedAt ?? record.grantedAt);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
