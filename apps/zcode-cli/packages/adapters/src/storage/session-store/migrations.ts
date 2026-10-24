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
];
