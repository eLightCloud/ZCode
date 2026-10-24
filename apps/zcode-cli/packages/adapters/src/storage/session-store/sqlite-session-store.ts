import type { MigrationResult } from "@zcode/shared/sqlite-migrations";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqliteSessionStoreApi } from "./sqlite-session-api.js";
import * as implementation0 from "./sqlite-session-checkpoints.js";
import * as implementation10 from "./sqlite-session-diagnostics.js";
import * as continuation from "./sqlite-session-continuation.js";
import * as implementation1 from "./sqlite-session-forks.js";
import * as implementation5 from "./sqlite-session-inputs.js";
import * as implementation4 from "./sqlite-session-messages.js";
import * as implementation3 from "./sqlite-session-metadata.js";
import * as implementation8 from "./sqlite-session-permissions.js";
import * as implementation2 from "./sqlite-session-shared-context.js";
import * as implementation6 from "./sqlite-session-targets.js";
import * as implementation7 from "./sqlite-session-usage.js";
import * as implementation9 from "./sqlite-session-workflows.js";
import { DatabaseSync } from "node:sqlite";
import type { InputHistoryStorePort } from "@zcode/contracts";
import type { LocalSettingStorePort } from "@zcode/contracts";
import type { ScriptWorkflowStorePort } from "@zcode/contracts";
import type { SessionStorePort } from "@zcode/contracts";
import type { UsageStorePort } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { SqliteSessionMigrationError } from "./errors.js";
import { DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS } from "./migration-runner.js";
import { runSqliteSessionMigrationsAsync } from "./migration-runner.js";
import type { AsyncSqliteMigrationOptions } from "./migration-runner.js";
import type { ForkCommitFaultStage } from "./options.js";
import type { SqliteSessionStoreOptions } from "./options.js";
import { getDefaultSessionDbPath } from "./paths.js";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

export { getDefaultSessionDbPath };

export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare exportTextCheckpoint: SqliteSessionStoreApi["exportTextCheckpoint"];
  declare controlContinuation: SqliteSessionStoreApi["controlContinuation"];
  declare importTextCheckpoint: SqliteSessionStoreApi["importTextCheckpoint"];
  declare createForkedSessionWithMetadata: SqliteSessionStoreApi["createForkedSessionWithMetadata"];
  declare commitForkBundle: SqliteSessionStoreApi["commitForkBundle"];
  declare commitSharedContextImportBundle: SqliteSessionStoreApi["commitSharedContextImportBundle"];
  declare transitionSharedContextImport: SqliteSessionStoreApi["transitionSharedContextImport"];
  declare createSession: SqliteSessionStoreApi["createSession"];
  declare softDeleteSession: SqliteSessionStoreApi["softDeleteSession"];
  declare updateSession: SqliteSessionStoreApi["updateSession"];
  declare getSession: SqliteSessionStoreApi["getSession"];
  declare listSessions: SqliteSessionStoreApi["listSessions"];
  declare claimLegacySessionWorkspace: SqliteSessionStoreApi["claimLegacySessionWorkspace"];
  declare repairLegacyRemoteSessionWorkspace: SqliteSessionStoreApi["repairLegacyRemoteSessionWorkspace"];
  declare repairRemoteSessionPaths: SqliteSessionStoreApi["repairRemoteSessionPaths"];
  declare setRevert: SqliteSessionStoreApi["setRevert"];
  declare clearRevert: SqliteSessionStoreApi["clearRevert"];
  declare saveMessage: SqliteSessionStoreApi["saveMessage"];
  declare removeMessage: SqliteSessionStoreApi["removeMessage"];
  declare savePart: SqliteSessionStoreApi["savePart"];
  declare removePart: SqliteSessionStoreApi["removePart"];
  declare messageWithParts: SqliteSessionStoreApi["messageWithParts"];
  declare messages: SqliteSessionStoreApi["messages"];
  declare saveSessionEntry: SqliteSessionStoreApi["saveSessionEntry"];
  declare sessionEntries: SqliteSessionStoreApi["sessionEntries"];
  declare saveSessionInput: SqliteSessionStoreApi["saveSessionInput"];
  declare updateSessionInputs: SqliteSessionStoreApi["updateSessionInputs"];
  declare promoteSessionInput: SqliteSessionStoreApi["promoteSessionInput"];
  declare markSessionInputPromoted: SqliteSessionStoreApi["markSessionInputPromoted"];
  declare settleSessionInput: SqliteSessionStoreApi["settleSessionInput"];
  declare listSessionInputs: SqliteSessionStoreApi["listSessionInputs"];
  declare getSessionInputById: SqliteSessionStoreApi["getSessionInputById"];
  declare recordInputHistory: SqliteSessionStoreApi["recordInputHistory"];
  declare recallPreviousInputHistory: SqliteSessionStoreApi["recallPreviousInputHistory"];
  declare readTodos: SqliteSessionStoreApi["readTodos"];
  declare updateTodos: SqliteSessionStoreApi["updateTodos"];
  declare readTarget: SqliteSessionStoreApi["readTarget"];
  declare setTarget: SqliteSessionStoreApi["setTarget"];
  declare cloneTargetForFork: SqliteSessionStoreApi["cloneTargetForFork"];
  declare createTarget: SqliteSessionStoreApi["createTarget"];
  declare updateTargetStatus: SqliteSessionStoreApi["updateTargetStatus"];
  declare startTargetRun: SqliteSessionStoreApi["startTargetRun"];
  declare heartbeatTargetRun: SqliteSessionStoreApi["heartbeatTargetRun"];
  declare finishTargetRun: SqliteSessionStoreApi["finishTargetRun"];
  declare recoverInterruptedTargetRun: SqliteSessionStoreApi["recoverInterruptedTargetRun"];
  declare accountTargetUsage: SqliteSessionStoreApi["accountTargetUsage"];
  declare updateTargetSummaryTitle: SqliteSessionStoreApi["updateTargetSummaryTitle"];
  declare clearTarget: SqliteSessionStoreApi["clearTarget"];
  declare recordModelUsage: SqliteSessionStoreApi["recordModelUsage"];
  declare upsertTurnUsage: SqliteSessionStoreApi["upsertTurnUsage"];
  declare upsertToolUsage: SqliteSessionStoreApi["upsertToolUsage"];
  declare pruneUsage: SqliteSessionStoreApi["pruneUsage"];
  declare queryAppUsage: SqliteSessionStoreApi["queryAppUsage"];
  declare queryTaskUsage: SqliteSessionStoreApi["queryTaskUsage"];
  declare commitPermissionFullAccess: SqliteSessionStoreApi["commitPermissionFullAccess"];
  declare getProjectPermission: SqliteSessionStoreApi["getProjectPermission"];
  declare saveProjectPermission: SqliteSessionStoreApi["saveProjectPermission"];
  declare getProjectPermissionMode: SqliteSessionStoreApi["getProjectPermissionMode"];
  declare saveProjectPermissionMode: SqliteSessionStoreApi["saveProjectPermissionMode"];
  declare upsertScriptWorkflowDefinition: SqliteSessionStoreApi["upsertScriptWorkflowDefinition"];
  declare createScriptWorkflowRun: SqliteSessionStoreApi["createScriptWorkflowRun"];
  declare updateScriptWorkflowRun: SqliteSessionStoreApi["updateScriptWorkflowRun"];
  declare getScriptWorkflowRun: SqliteSessionStoreApi["getScriptWorkflowRun"];
  declare listScriptWorkflowRuns: SqliteSessionStoreApi["listScriptWorkflowRuns"];
  declare createScriptWorkflowActivity: SqliteSessionStoreApi["createScriptWorkflowActivity"];
  declare updateScriptWorkflowActivity: SqliteSessionStoreApi["updateScriptWorkflowActivity"];
  declare findCachedScriptWorkflowActivity: SqliteSessionStoreApi["findCachedScriptWorkflowActivity"];
  declare listScriptWorkflowActivities: SqliteSessionStoreApi["listScriptWorkflowActivities"];
  declare appendScriptWorkflowEvent: SqliteSessionStoreApi["appendScriptWorkflowEvent"];
  declare listScriptWorkflowEvents: SqliteSessionStoreApi["listScriptWorkflowEvents"];
  declare createSessionTaskLink: SqliteSessionStoreApi["createSessionTaskLink"];
  declare workflowJournalStore: SqliteSessionStoreApi["workflowJournalStore"];
  declare debugMigrationIds: SqliteSessionStoreApi["debugMigrationIds"];
  declare debugCounts: SqliteSessionStoreApi["debugCounts"];

  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;
  private readonly checkpointLogger?: SqliteSessionStoreOptions["logger"];
  private dwfJournalStore?: JournalStorePort;

  private constructor(
    db: DatabaseSync,
    dbPath: string,
    options: SqliteSessionStoreOptions,
    readonly migrationResult: MigrationResult,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.forkCommitFaultAt = options.forkCommitFaultAt;
    this.checkpointLogger = options.logger;
  }

  static async open(
    options: SqliteSessionStoreOptions = {},
    migrationOptions?: AsyncSqliteMigrationOptions,
  ): Promise<SqliteSessionStore> {
    const dbPath = options.dbPath ?? getDefaultSessionDbPath();
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    let db: DatabaseSync;
    try {
      if (dbPath !== ":memory:") {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(dbPath) });
        await mkdir(dirname(dbPath), { recursive: true });
      }
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: dbPath });
      db = new DatabaseSync(dbPath, { timeout: startupLockTimeoutMs });
    } catch (error) {
      throw new SqliteSessionMigrationError(`Failed to open SQLite session database at ${dbPath}`, {
        cause: error,
        dbPath,
        kind: "open_failed",
      });
    }
    try {
      db.function("zcode_portable_context_version", { deterministic: true }, () => 4);
      const migration = await runSqliteSessionMigrationsAsync(
        db,
        dbPath,
        migrationOptions ?? { lockWaitTimeoutMs: startupLockTimeoutMs },
      );
      return new SqliteSessionStore(db, dbPath, options, migration);
    } catch (error) {
      try {
        db.close();
      } catch {
        /* 关闭失败不能覆盖迁移错误。 */
      }
      throw error;
    }
  }

  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ) {
    return SqliteSessionStore.open(options, migrationOptions);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  // ── session_input 账本──

  /**
   * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
   * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
   */
}

// 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
for (const methods of [
  implementation0,
  implementation1,
  implementation2,
  implementation3,
  implementation4,
  implementation5,
  implementation6,
  implementation7,
  implementation8,
  implementation9,
  implementation10,
  continuation,
]) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(SqliteSessionStore.prototype, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open(options);
}
