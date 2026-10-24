import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConversationSyncOutbox } from "../src/conversation-sync/outbox.js";
it("preserves location and original input ownership across Host restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-owner-"));
  const path = join(root, "sync.sqlite");
  const first = { tenant: randomUUID(), subject: randomUUID() };
  const second = { ...first, subject: randomUUID() };
  let outbox = createConversationSyncOutbox(path);
  try {
    const location = outbox.location();
    outbox.bindInput(first, "original", null);
    expect(() => outbox.bindInput(second, "original", null)).toThrow();
    expect(outbox.ownsSession(second, "session", "original")).toBe(false);
    expect(outbox.ownsSession(first, "session", "original")).toBe(true);
    expect(() => outbox.bindInput(second, "later-input", "session")).toThrow("scope");
    outbox.bindInput(second, "later-input", "other-session");
    expect(outbox.ownsSession(second, "other-session", "later-input")).toBe(true);
    expect(outbox.ownsSession(second, "session", "later-input")).toBe(false);
    outbox.close();
    outbox = createConversationSyncOutbox(path);
    expect(outbox.location()).toBe(location);
    expect(outbox.ownsSession(first, "session")).toBe(true);
    expect(outbox.ownsSession(second, "session")).toBe(false);
  } finally {
    outbox.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("upgrades the previous owned outbox v1 while refusing foreign SQLite stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-v1-"));
  const path = join(root, "sync.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`create table sync_outbox(tenant text, subject text, session text, operation text, fingerprint text, request text, receipt text, sequence integer);
    create table sync_cursor(tenant text,subject text,cursor integer,primary key(tenant,subject));
    insert into sync_cursor values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',7);
    pragma application_id=1514361689; pragma user_version=1;`);
  db.close();
  try {
    const upgraded = createConversationSyncOutbox(path);
    expect(
      upgraded.cursor({
        tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        subject: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toBe(7);
    upgraded.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
