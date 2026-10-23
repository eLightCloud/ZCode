import type {
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionTaskLinkInput,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  SessionTaskLinkRecord,
  UpdateScriptWorkflowActivityInput,
  UpdateScriptWorkflowRunInput,
  UpsertScriptWorkflowDefinitionInput,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@zcode/dynamic-workflow";

import { createDwfJournalStore } from "./repositories/dwf-journal.js";

import * as scriptWorkflowActivityRepository from "./repositories/script-workflow-activities.js";

import * as scriptWorkflowRunRepository from "./repositories/script-workflow-runs.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function upsertScriptWorkflowDefinition(
  this: SqliteSessionStoreContext,
  input: UpsertScriptWorkflowDefinitionInput,
): Promise<ScriptWorkflowDefinitionRecord> {
  return scriptWorkflowRunRepository.upsertScriptWorkflowDefinition(this.db, input);
}

export async function createScriptWorkflowRun(
  this: SqliteSessionStoreContext,
  input: CreateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  return scriptWorkflowRunRepository.createScriptWorkflowRun(this.db, input);
}

export async function updateScriptWorkflowRun(
  this: SqliteSessionStoreContext,
  input: UpdateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  return scriptWorkflowRunRepository.updateScriptWorkflowRun(this.db, input);
}

export async function getScriptWorkflowRun(
  this: SqliteSessionStoreContext,
  runId: string,
): Promise<ScriptWorkflowRunRecord | null> {
  return scriptWorkflowRunRepository.getScriptWorkflowRun(this.db, runId);
}

export async function listScriptWorkflowRuns(
  this: SqliteSessionStoreContext,
  input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  },
): Promise<ScriptWorkflowRunRecord[]> {
  return scriptWorkflowRunRepository.listScriptWorkflowRuns(this.db, input);
}

export async function createScriptWorkflowActivity(
  this: SqliteSessionStoreContext,
  input: CreateScriptWorkflowActivityInput,
): Promise<ScriptWorkflowActivityRecord> {
  return scriptWorkflowActivityRepository.createScriptWorkflowActivity(this.db, input);
}

export async function updateScriptWorkflowActivity(
  this: SqliteSessionStoreContext,
  input: UpdateScriptWorkflowActivityInput,
): Promise<ScriptWorkflowActivityRecord> {
  return scriptWorkflowActivityRepository.updateScriptWorkflowActivity(this.db, input);
}

export async function findCachedScriptWorkflowActivity(
  this: SqliteSessionStoreContext,
  input: {
    callPath: string;
    inputHash: string;
    runId: string;
  },
): Promise<ScriptWorkflowActivityRecord | null> {
  return scriptWorkflowActivityRepository.findCachedScriptWorkflowActivity(this.db, input);
}

export async function listScriptWorkflowActivities(
  this: SqliteSessionStoreContext,
  input: {
    runId: string;
  },
): Promise<ScriptWorkflowActivityRecord[]> {
  return scriptWorkflowActivityRepository.listScriptWorkflowActivities(this.db, input);
}

export async function appendScriptWorkflowEvent(
  this: SqliteSessionStoreContext,
  input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  },
): Promise<ScriptWorkflowEventRecord> {
  return scriptWorkflowActivityRepository.appendScriptWorkflowEvent(this.db, input);
}

export async function listScriptWorkflowEvents(
  this: SqliteSessionStoreContext,
  input: {
    limit?: number;
    runId: string;
  },
): Promise<ScriptWorkflowEventRecord[]> {
  return scriptWorkflowActivityRepository.listScriptWorkflowEvents(this.db, input);
}

export async function createSessionTaskLink(
  this: SqliteSessionStoreContext,
  input: CreateSessionTaskLinkInput,
): Promise<SessionTaskLinkRecord> {
  return scriptWorkflowActivityRepository.createSessionTaskLink(this.db, input);
}

/**
 * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
 * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
 */

export function workflowJournalStore(this: SqliteSessionStoreContext): JournalStorePort {
  this.dwfJournalStore ??= createDwfJournalStore(this.db);
  return this.dwfJournalStore;
}
