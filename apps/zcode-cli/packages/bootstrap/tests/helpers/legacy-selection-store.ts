import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { SESSION_ENTRY_MODEL_SELECTION, type SessionId } from "@zcode/contracts";
import { SQLITE_MIGRATIONS } from "../../../adapters/src/storage/session-store/migrations.js";

/** 旧数据必须从磁盘播种；新版 writer 会包装新字段，不能拿它伪造升级前状态。 */
export async function createLegacySelectionStoreFixture(legacy?: {
  sessionID: SessionId;
  messageID: string;
  partID: string;
  projectID: string;
  directory: string;
  slug: string;
  title: string;
  text: string;
  modelSelection: unknown;
  selection: unknown;
}) {
  const root = await mkdtemp(join(tmpdir(), "app-legacy-selection-"));
  const dbPath = join(root, "sessions.sqlite");
  if (legacy) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TABLE schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
      );
      for (const migration of SQLITE_MIGRATIONS.filter((item) => item.id < "0020")) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
          migration.id,
          createHash("sha256").update(migration.sql.trim()).digest("hex"),
          migration.appVersion,
          1,
        );
      }
      db.prepare(
        "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        legacy.sessionID,
        legacy.projectID,
        legacy.slug,
        legacy.directory,
        legacy.title,
        "test",
        1,
        2,
      );
      db.prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
      ).run(
        legacy.messageID,
        legacy.sessionID,
        1,
        1,
        JSON.stringify({
          role: "user",
          agent: "zcode-agent",
          time: { created: 1 },
          modelSelection: legacy.modelSelection,
        }),
      );
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(
        legacy.partID,
        legacy.messageID,
        legacy.sessionID,
        1,
        1,
        JSON.stringify({ type: "text", text: legacy.text }),
      );
      db.prepare(
        "INSERT INTO session_entry(id,session_id,type,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(
        `${legacy.sessionID}:runtime-model-selection`,
        legacy.sessionID,
        SESSION_ENTRY_MODEL_SELECTION,
        2,
        2,
        JSON.stringify(legacy.selection),
      );
    } finally {
      db.close();
    }
  }
  const store = await createSqliteSessionStore({ dbPath });
  return {
    get store() {
      return store;
    },
    async dispose() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
