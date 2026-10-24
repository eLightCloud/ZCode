import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { CONVERSATION_BARRIER_SQL } from "../../src/session/conversation-index-persistence/contract.js";
it("keeps management changes fenced until the native index barrier is released", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "create table tasks(workspace_key text,task_id text,pinned integer,archived integer,deleted integer,title_overridden integer,title text); insert into tasks values('owned-workspace','owned-session',0,0,0,0,'owned title');",
    );
    db.exec(CONVERSATION_BARRIER_SQL);
    db.prepare("insert into conversation_index_barriers values(?,?,?)").run(
      "owned-workspace",
      "owned-session",
      "owned-operation",
    );
    expect(() => db.exec("update tasks set pinned=1")).toThrow(
      "conversation_index_admission_closed",
    );
    expect(db.prepare("select pinned from tasks").get()?.pinned).toBe(0);
    db.exec("delete from conversation_index_barriers;update tasks set pinned=1;");
    expect(db.prepare("select pinned from tasks").get()?.pinned).toBe(1);
  } finally {
    db.close();
  }
});
