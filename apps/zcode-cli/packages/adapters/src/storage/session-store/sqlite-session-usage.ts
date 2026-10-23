import type {
  AppUsageQueryInput,
  AppUsageQueryResult,
  ModelUsageRecord,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  ToolUsageRecord,
  TurnUsageRecord,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import * as usageRepository from "./repositories/usage.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function recordModelUsage(
  this: SqliteSessionStoreContext,
  input: ModelUsageRecord,
): Promise<void> {
  return usageRepository.recordModelUsage(this.db, input);
}

export async function upsertTurnUsage(
  this: SqliteSessionStoreContext,
  input: TurnUsageRecord,
): Promise<void> {
  return usageRepository.upsertTurnUsage(this.db, input);
}

export async function upsertToolUsage(
  this: SqliteSessionStoreContext,
  input: ToolUsageRecord,
): Promise<void> {
  return usageRepository.upsertToolUsage(this.db, input);
}

export async function pruneUsage(
  this: SqliteSessionStoreContext,
  input?: { beforeTime?: number },
): Promise<void> {
  return usageRepository.pruneUsage(this.db, input);
}

export async function queryAppUsage(
  this: SqliteSessionStoreContext,
  input: AppUsageQueryInput,
): Promise<AppUsageQueryResult> {
  return usageRepository.queryAppUsage(this.db, input);
}

export async function queryTaskUsage(
  this: SqliteSessionStoreContext,
  input: TaskUsageQueryInput,
): Promise<TaskUsageQueryResult> {
  return usageRepository.queryTaskUsage(this.db, input);
}
