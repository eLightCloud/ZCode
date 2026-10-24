import type { SqliteMigration } from "./migration-contract.js";
import { migrations as execution } from "./migration-execution.js";
import { migrations as inputs } from "./migration-input-ledger.js";
import { migrations as journal } from "./migration-journal.js";
import { migrations as baseline } from "./migration-session-baseline.js";
import { migrations as usage } from "./migration-usage.js";
import { migrations as workflow } from "./migration-workflow-runtime.js";
export type { SqliteMigration } from "./migration-contract.js";

// 历史迁移只分组存放；ID、执行顺序和 SQL 保持不变，不重跑已提交迁移。
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  ...baseline,
  ...workflow,
  ...usage,
  ...execution,
  ...inputs,
  ...journal,
];
