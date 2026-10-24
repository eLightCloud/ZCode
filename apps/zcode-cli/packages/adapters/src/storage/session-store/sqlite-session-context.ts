import type { DatabaseSync } from "node:sqlite";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { ForkCommitFaultStage, SqliteSessionStoreOptions } from "./options.js";

/** 同一 SQLite writer 的内部视图，仅包含实现实际使用的字段与写入钩子。 */
export interface SqliteSessionStoreContext {
  readonly db: DatabaseSync;
  readonly checkpointLogger: SqliteSessionStoreOptions["logger"];
  dwfJournalStore: JournalStorePort | undefined;
  throwBeforeWrite(): void;
  maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void;
}
