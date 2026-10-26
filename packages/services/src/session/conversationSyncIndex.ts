import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  zcodeTaskMetaSchema,
  type ZCodeTaskMeta,
  type ConversationIndexFacts,
} from "@zcode/shared";
import { getConversationWorkspaceDir } from "../paths.js";
import type { TaskIndexRow } from "./taskIndexRepo.js";
import { isConversationWorkspaceCandidate } from "./tasksDatabase/conversation-classification-v4.js";

/** Internal task-index read boundary. Only its facade supplies rows and serializes writers. */
export async function captureConversationIndexFacts<T>(options: {
  database: DatabaseSync;
  read(): TaskIndexRow | null;
  isCurrent(database: DatabaseSync): boolean;
  target: {
    workspacePath: string;
    taskId: string;
    workspaceIdentity?: string;
    legacy?: boolean;
    attributeLegacy?: boolean;
  };
  capture(facts: ConversationIndexFacts): Promise<T>;
}) {
  const database = options.database;
  const guard = () =>
    JSON.stringify([
      database.prepare("pragma data_version").get()?.data_version,
      database.prepare("select total_changes() as changes").get()?.changes,
    ]);
  const before = guard(),
    row = options.read();
  if (
    !row ||
    row.workspace_identity ||
    options.target.workspaceIdentity ||
    row.project_id ||
    row.execution_directories != null ||
    !isConversationWorkspaceCandidate(row.workspace_path) ||
    resolve(row.workspace_path) !== resolve(options.target.workspacePath) ||
    row.provider !== "glm" ||
    row.migration_source ||
    row.cron_automation_id ||
    row.off_peak_task_id
  )
    throw new Error("conversation_sync_ineligible");
  const registered =
    database
      .prepare("select purpose from conversation_workspace_purpose where workspace_key=?")
      .get(row.workspace_key)?.purpose === "conversation";
  if (
    !options.target.legacy &&
    !registered &&
    resolve(row.workspace_path) !== resolve(getConversationWorkspaceDir())
  )
    throw new Error("conversation_sync_unsupported_index");
  const raw: unknown = JSON.parse(row.meta_json),
    parsed = zcodeTaskMetaSchema.safeParse(raw);
  if (
    !parsed.success ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !Object.hasOwn(zcodeTaskMetaSchema.shape, key))
  )
    throw new Error("conversation_sync_unsupported_index");
  const meta = parsed.data;
  if (
    !isConversationSyncMeta(meta, options.target.legacy, row.workspace_path) ||
    meta.taskId !== row.task_id ||
    resolve(meta.workspacePath) !== resolve(row.workspace_path)
  )
    throw new Error("conversation_sync_unsupported_index");
  if ((meta.forkedFromTaskId ?? null) !== (row.forked_from_task_id ?? null))
    throw new Error("conversation_sync_unsupported_index");
  const result = await options.capture({
    ...(meta.forkedFromTaskId ? { parentSessionId: meta.forkedFromTaskId } : {}),
    titleOverride: row.title_overridden === 1 ? row.title : null,
    archived: row.archived === 1,
    deleted: row.deleted === 1,
    pinned: row.pinned === 1,
  });
  // 单进程写链不足以证明跨 Host 一致；另一连接的提交（含 ABA）与本连接写入都须复查。
  if (before !== guard() || !options.isCurrent(database))
    throw new Error("conversation_sync_index_changed");
  if (options.target.attributeLegacy) {
    // 显式迁入仅改变已核对内部会话的用途；跨连接变化必须在写锁内再次拒绝。
    database.exec("begin immediate");
    try {
      if (before !== guard()) throw new Error("conversation_sync_index_changed");
      database
        .prepare(
          "update tasks set meta_json=json_set(meta_json,'$.workspacePurpose','conversation') where workspace_key=? and task_id=?",
        )
        .run(row.workspace_key, row.task_id);
      database
        .prepare(
          "insert into conversation_workspace_purpose values(?,'conversation') on conflict do nothing",
        )
        .run(row.workspace_key);
      database.exec("commit");
    } catch (error) {
      database.exec("rollback");
      throw error;
    }
  }
  return result;
}

/** capture 与 create-only rebuild 共享资格；新增事实不能只在一端被接受。 */
export function isConversationSyncMeta(
  meta: ZCodeTaskMeta,
  legacy = false,
  workspacePath = getConversationWorkspaceDir(),
): boolean {
  return (
    (meta.workspacePurpose === "conversation" || (legacy && meta.workspacePurpose === undefined)) &&
    !meta.workspaceIdentity &&
    isConversationWorkspaceCandidate(workspacePath) &&
    resolve(meta.workspacePath) === resolve(workspacePath) &&
    meta.provider === "glm" &&
    !meta.target &&
    !meta.cronAutomationId &&
    !meta.offPeakTaskId &&
    !meta.migrationSource &&
    !meta.repairState &&
    !meta.changeSummary
  );
}
