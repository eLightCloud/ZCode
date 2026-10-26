import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHostConversationSyncSource } from "../src/conversation-sync/host-source.js";
import { createConversationSyncOutbox } from "../src/conversation-sync/outbox.js";
import { checkpoint } from "../checks/sync-fixture.mjs";

it("distinguishes absent bases from corrupt branch modes without rewriting either", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-mode-")),
    path = join(root, "outbox.sqlite");
  const scope = { tenant: randomUUID(), subject: randomUUID() };
  const outbox = createConversationSyncOutbox(path);
  const db = new DatabaseSync(path);
  try {
    expect(outbox.branchMode(scope, "new-session")).toBe("primary");
    outbox.adopt(
      scope,
      {
        id: "base",
        parent: null,
        location: outbox.location(),
        generation: 0,
        checkpoint: checkpoint("session"),
      },
      0,
      randomUUID(),
      "offline",
    );
    expect(outbox.branchMode(scope, "session")).toBe("offline");
    db.exec("update sync_bases set mode='unknown'");
    expect(() => outbox.branchMode(scope, "session")).toThrowError(
      expect.objectContaining({ code: "schema" }),
    );
    expect(db.prepare("select mode from sync_bases").get()?.mode).toBe("unknown");
  } finally {
    db.close();
    outbox.close();
    await rm(root, { recursive: true, force: true });
  }
});
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

it("binds automatic capture to the first real input after a model maintenance marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-maintenance-owner-"));
  const outbox = createConversationSyncOutbox(join(root, "sync.sqlite"));
  const scope = { tenant: randomUUID(), subject: randomUUID() };
  const base = checkpoint("synthetic-session");
  base.messages[0].info.anchor = { sourceCommandId: "original" };
  const first = {
    info: {
      ...base.messages[1].info,
      id: "model-initial",
      parentID: "model-initial",
      finish: "completed",
      anchor: { sourceCommandId: "model-change" },
      semantics: {
        origin: "system",
        kind: "timeline_event",
        uiVisibility: "visible",
        providerVisibility: "hidden",
        transcriptVisibility: "visible",
      },
    },
    parts: [
      {
        id: "model-marker",
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        toModel: { ...base.modelSelection, label: "Synthetic" },
      },
    ],
  };
  const value = { ...base, version: 4, messages: [first, ...base.messages] };
  const blocked: string[] = [];
  outbox.bindInput(scope, "original", null);
  try {
    const source = createHostConversationSyncSource({
      scope,
      location: outbox.location(),
      trustedInstance: false,
      outbox,
      blocked: (_session, code) => blocked.push(code),
      host: {
        enumerate: async () => [base.session.id],
        capture: async () => ({
          dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
          management: { titleOverride: null, archived: false, deleted: false, pinned: false },
        }),
      },
    });
    expect((await source.changes(0)).items).toHaveLength(1);
    expect(blocked).toEqual([]);
    expect(outbox.ownsSession(scope, base.session.id)).toBe(true);
  } finally {
    outbox.close();
    await rm(root, { recursive: true, force: true });
  }
});
