import type { SqliteMigration } from "./migration-contract.js";
import { migrations as execution } from "./migration-execution.js";
import { migrations as inputs } from "./migration-input-ledger.js";
import { migrations as journal } from "./migration-journal.js";
import { migrations as baseline } from "./migration-session-baseline.js";
import { migrations as usage } from "./migration-usage.js";
import { migrations as workflow } from "./migration-workflow-runtime.js";
import { SESSION_CONTINUATION_MIGRATION_SQL } from "./migrations/0023-session-continuation.js";
export type { SqliteMigration } from "./migration-contract.js";

// 历史迁移只分组存放；ID、执行顺序和 SQL 保持不变，不重跑已提交迁移。
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  ...baseline,
  ...workflow,
  ...usage,
  ...execution,
  ...inputs,
  ...journal,
  {
    appVersion: "0.16.9",
    id: "0025_session_continuation",
    previousIds: ["0023_session_continuation"],
    touchedTables: ["session_continuation", "session_continuation_receipt"],
    sql: SESSION_CONTINUATION_MIGRATION_SQL,
  },
  {
    appVersion: "0.17.0",
    id: "0026_portable_context_writer",
    touchedTables: ["session", "message", "part", "session_input", "session_entry", "todo"],
    // 旧迁移器忽略未知 ID。升级后的完整上下文必须由支持 v4 的 writer 修改；
    // 旧连接缺少能力函数便明确拒写。只读仍可用，回退使用独立升级前快照。
    sql: `alter table session add column last_outcome_input_id text;
      alter table session add column last_outcome_at integer;
      ${["session", "message", "part", "session_input", "session_entry", "todo"].flatMap(table =>
        ["insert", "update", "delete"].map(action =>
          `create trigger portable_context_${table}_${action} before ${action} on ${table} begin select case when zcode_portable_context_version()<4 then raise(abort,'portable context writer required') end; end;`
        )).join("\n")}`,
  },
];
