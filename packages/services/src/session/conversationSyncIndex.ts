import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { zcodeTaskMetaSchema, type ConversationIndexFacts } from "@zcode/shared";
import { getConversationWorkspaceDir } from "../paths.js";
import type { TaskIndexRow } from "./taskIndexRepo.js";

/** Internal task-index read boundary. Only its facade supplies rows and serializes writers. */
export async function captureConversationIndexFacts<T>(options: {
  database: DatabaseSync;
  read(): TaskIndexRow | null;
  isCurrent(database: DatabaseSync): boolean;
  target: { workspacePath: string; taskId: string; workspaceIdentity?: string };
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
    resolve(row.workspace_path) !== resolve(getConversationWorkspaceDir()) ||
    row.provider !== "glm" ||
    row.migration_source ||
    row.forked_from_task_id ||
    row.cron_automation_id ||
    row.off_peak_task_id
  )
    throw new Error("conversation_sync_ineligible");
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
    meta.target ||
    meta.cronAutomationId ||
    meta.offPeakTaskId ||
    meta.forkedFromTaskId ||
    meta.migrationSource ||
    meta.repairState ||
    meta.changeSummary ||
    meta.workspaceIdentity ||
    meta.taskId !== row.task_id ||
    resolve(meta.workspacePath) !== resolve(row.workspace_path) ||
    meta.workspacePurpose !== "conversation"
  )
    throw new Error("conversation_sync_unsupported_index");
  const result = await options.capture({
    titleOverride: row.title_overridden === 1 ? row.title : null,
    archived: row.archived === 1,
    deleted: row.deleted === 1,
    pinned: row.pinned === 1,
  });
  // 单进程写链不足以证明跨 Host 一致；另一连接的提交（含 ABA）与本连接写入都须复查。
  if (before !== guard() || !options.isCurrent(database))
    throw new Error("conversation_sync_index_changed");
  return result;
}
