import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  syncRequestSchema,
  type SyncState,
  type SyncCommand,
  type SyncVersion,
} from "@zcode/contracts";
import {
  initialState,
  transition as applyTransition,
  transitionContinuationSelection,
  versionFacts,
} from "../src/conversation-sync/transitions.js";
import { canonical, digest } from "../src/conversation-sync/canonical.js";
import { createConversationSyncOutbox } from "../src/conversation-sync/outbox.js";
import { checkpoint } from "../checks/sync-fixture.mjs";
import { textCheckpointSchema } from "@zcode/contracts";
import { createConversationSyncHttpClient } from "../src/conversation-sync/client.js";

function transition(state: SyncState, command: SyncCommand, versions: Map<string, SyncVersion>) {
  return applyTransition(
    state,
    command,
    new Map([...versions].map(([id, value]) => [id, versionFacts(value)])),
  );
}
function version(id: string, parent: string | null = null): SyncVersion {
  return { id, parent, location: "desktop", generation: 1, checkpoint: null };
}
function live(): { state: SyncState; versions: Map<string, SyncVersion> } {
  const state = initialState();
  state.selected = "base";
  state.candidates = ["base"];
  state.generation = 1;
  state.active = { location: "desktop", generation: 1, version: "base" };
  const versions = new Map([["base", version("base")]]);
  return { state, versions };
}
describe("native conversation sync transitions", () => {
  it("permits only the exact trusted private HTTP origin or an explicit loopback client", () => {
    const scope = { tenant: randomUUID(), subject: randomUUID() };
    const options = {
      scope,
      currentScope: () => scope,
      credential: async () => "synthetic",
      httpClient: {
        request: async () => {
          throw new Error("no_network_expected");
        },
      },
      timeoutMs: 1000,
      maxResponseBytes: 1000,
      trace: { traceId: "synthetic" as never },
    };
    const url = "http://synthetic-private:48223/api/native/conversations";
    expect(() => createConversationSyncHttpClient({ ...options, url })).toThrow();
    expect(() =>
      createConversationSyncHttpClient({
        ...options,
        url,
        trustedHttpOrigin: "http://other:48223",
      }),
    ).toThrow();
    expect(() =>
      createConversationSyncHttpClient({
        ...options,
        url,
        trustedHttpOrigin: "http://synthetic-private:48223",
      }),
    ).not.toThrow();
    expect(() =>
      createConversationSyncHttpClient({
        ...options,
        url: "http://localhost:48223/api/native/conversations",
        allowLoopbackHttp: true,
      }),
    ).not.toThrow();
  });
  it("canonical fingerprints ignore object order but preserve semantic arrays", () => {
    expect(digest({ b: 2, a: [1, 2] })).toBe(digest({ a: [1, 2], b: 2 }));
    expect(digest({ a: [2, 1], b: 2 })).not.toBe(digest({ a: [1, 2], b: 2 }));
    expect(canonical({ absent: undefined, present: null })).toBe('{"present":null}');
  });
  it("rejects values that JSON would silently change before persistence", () => {
    expect(() => canonical({ cost: Infinity })).toThrowError(
      expect.objectContaining({ code: "invalid" }),
    );
    expect(() => canonical([undefined])).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => canonical(new Date())).toThrowError(expect.objectContaining({ code: "invalid" }));
  });
  it("receiving a branch never implicitly promotes or activates it", () => {
    const { state, versions } = live();
    const next = transition(
      state,
      { kind: "receive", version: version("branch", "base") },
      versions,
    );
    expect(next.selected).toBe("base");
    expect(next.active).toEqual(state.active);
    expect(next.candidates).toEqual(["branch"]);
  });
  it("rejects unknown parent and immutable version identity reuse", () => {
    const { state, versions } = live();
    expect(() =>
      transition(state, { kind: "receive", version: version("branch", "unknown") }, versions),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() =>
      transition(state, { kind: "receive", version: version("base") }, versions),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
  });
  it("does not turn unknown evidence into a barrier proof", () => {
    expect(
      syncRequestSchema.safeParse({
        session: "session",
        operation: randomUUID(),
        command: {
          kind: "grant",
          revision: 1,
          handoff: "h",
          checkpoint: "c",
          sourceBarrier: false,
          dependenciesVerified: true,
        },
      }).success,
    ).toBe(false);
    expect(
      textCheckpointSchema.safeParse({ format: "zcode.text-checkpoint", version: 99 }).success,
    ).toBe(false);
  });
  it("cannot choose a whole copy while a location still accepts or awaits activation", () => {
    const { state, versions } = live();
    expect(() =>
      transition(
        state,
        {
          kind: "select",
          revision: 0,
          candidates: ["base"],
          version: "base",
          location: null,
          recoveryVerified: false,
        },
        versions,
      ),
    ).toThrowError(expect.objectContaining({ code: "blocked" }));
  });
  it("cancellation fences the old generation and cannot resurrect the same handoff", () => {
    const { state, versions } = live();
    const requested = transition(
      state,
      {
        kind: "begin",
        revision: 0,
        handoff: "h",
        source: "desktop",
        generation: 1,
        target: "cloud",
        baseline: "base",
      },
      versions,
    );
    const cancelled = transition(requested, { kind: "cancel", handoff: "h" }, versions);
    expect(cancelled.active?.generation).toBe(2);
    expect(() =>
      transition(
        cancelled,
        {
          kind: "grant",
          revision: 2,
          handoff: "h",
          checkpoint: "base",
          sourceBarrier: true,
          dependenciesVerified: true,
        },
        versions,
      ),
    ).toThrowError(expect.objectContaining({ code: "stale" }));
  });
  it("linear data after a selected tombstone still needs an explicit choice", () => {
    const { state, versions } = live();
    state.active = null;
    state.candidates = ["new"];
    versions.set("new", { ...version("new", "base"), checkpoint: checkpoint() });
    expect(() =>
      transition(
        state,
        {
          kind: "promote",
          revision: 0,
          version: "new",
          location: "desktop",
          otherOwnersSettled: true,
        },
        versions,
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
  });
  it("normal deletion requires no recovery payload and leaves execution closed", () => {
    const { state, versions } = live();
    state.active = null;
    const deleted = transition(
      state,
      {
        kind: "select",
        revision: 0,
        candidates: ["base"],
        version: "base",
        location: null,
        recoveryVerified: false,
      },
      versions,
    );
    expect(deleted.selected).toBe("base");
    expect(deleted.active).toBe(null);
    expect(deleted.pending).toBe(null);
  });
  it("rejects stale activation and selection generations", () => {
    const { state, versions } = live();
    expect(() =>
      transition(
        state,
        {
          kind: "activate",
          revision: 0,
          location: "desktop",
          generation: 1,
          version: "base",
          recoveryVerified: true,
        },
        versions,
      ),
    ).toThrowError(expect.objectContaining({ code: "stale" }));
    expect(() =>
      transition(
        state,
        {
          kind: "select",
          revision: 99,
          candidates: ["base"],
          version: "base",
          location: null,
          recoveryVerified: false,
        },
        versions,
      ),
    ).toThrowError(expect.objectContaining({ code: "stale" }));
  });
});
describe("native sync metadata migration boundary", () => {
  it("refuses an unknown schema without rewriting existing custom plugin tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-schema-"));
    const path = join(root, "existing.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "create table user_plugin(config text); insert into user_plugin values('custom'); pragma user_version=77",
    );
    db.close();
    try {
      expect(() => createConversationSyncOutbox(path)).toThrowError(
        expect.objectContaining({ code: "schema" }),
      );
      const check = new DatabaseSync(path);
      expect(check.prepare("select config from user_plugin").get()?.config).toBe("custom");
      expect(check.prepare("pragma user_version").get()?.user_version).toBe(77);
      check.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not mistake another component's schema version 1 for the sync database", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-owner-"));
    const path = join(root, "user-plugin.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "create table plugin(config text); insert into plugin values('retained'); pragma user_version=1",
    );
    db.close();
    try {
      expect(() => createConversationSyncOutbox(path)).toThrowError(
        expect.objectContaining({ code: "schema" }),
      );
      const original = new DatabaseSync(path);
      expect(original.prepare("pragma journal_mode").get()?.journal_mode).toBe("delete");
      expect(original.prepare("select config from plugin").get()?.config).toBe("retained");
      original.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reopens a dedicated empty outbox and keeps account cursors independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-outbox-"));
    const path = join(root, "outbox.sqlite");
    const a = { tenant: randomUUID(), subject: randomUUID() };
    const b = { tenant: a.tenant, subject: randomUUID() };
    try {
      const original = createConversationSyncOutbox(path);
      original.capture(a, 4, 0, []);
      original.close();
      const reopened = createConversationSyncOutbox(path);
      expect(reopened.cursor(a)).toBe(4);
      expect(reopened.cursor(b)).toBe(0);
      expect(() => reopened.capture(a, 5, 0, [])).toThrowError(
        expect.objectContaining({ code: "stale" }),
      );
      expect(reopened.cursor(a)).toBe(4);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("keeps ordinary selection fenced and publishes only the atomic trusted choice state", () => {
  const { state, versions } = live();
  versions.set("base", {
    ...versions.get("base")!,
    checkpoint: checkpoint("atomic-session"),
    management: { titleOverride: null, pinned: false, archived: false, deleted: false },
  });
  const facts = new Map([...versions].map(([id, value]) => [id, versionFacts(value)]));
  const choice = {
    kind: "select" as const,
    revision: state.revision,
    candidates: ["base"],
    version: "base",
    location: "cloud",
    recoveryVerified: true,
  };
  expect(() => applyTransition(state, choice, facts)).toThrow();
  const original = structuredClone(state);
  expect(() =>
    transitionContinuationSelection(state, { ...choice, candidates: ["unseen"] }, facts),
  ).toThrow();
  expect(state).toEqual(original);
  const next = transitionContinuationSelection(state, choice, facts);
  expect(next.active).toBeNull();
  expect(next.pending?.location).toBe("cloud");
  expect(next.generation).toBeGreaterThan(state.generation);
  expect(state).toEqual(original);
});
