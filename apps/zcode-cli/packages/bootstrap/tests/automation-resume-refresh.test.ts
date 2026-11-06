import { describe, expect, it, vi } from "vitest";
import {
  SessionResidentPool,
  type SessionResidencyFacts,
} from "../src/zcode-protocol/session-resident-pool.js";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionId, ProjectId, MessageId } from "@zcode/contracts";
import { zcodeProtocolMethods } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { ZCodeAppOptions } from "../src/app/types.js";

const safe = (): SessionResidencyFacts => ({
  persisted: true,
  hasResidencyBlockingWork: false,
  hasPendingInteractions: false,
  hasQueuedCommands: false,
  hasSubscribers: true,
  hasLegacySubscriber: false,
  lastActivityAt: 1,
});

function fixture(facts = safe(), close = async () => {}) {
  const ids = new Set(["target", "other"]);
  const deactivate = vi.fn((id: string) => {
    ids.delete(id);
    return close();
  });
  const pool = new SessionResidentPool({
    listSessionIds: () => [...ids],
    readResidencyFacts: () => facts,
    deactivate,
  });
  return { pool, ids, deactivate };
}

describe("automation resume refresh", () => {
  it("refreshes only the requested idle session with read-only subscribers", async () => {
    const { pool, ids, deactivate } = fixture();
    const release = await pool.acquireOperation("target");
    await pool.refreshForResume("target");
    expect([...ids]).toEqual(["other"]);
    expect(deactivate).toHaveBeenCalledExactlyOnceWith("target");
    release();
  });

  it.each([
    { ...safe(), persisted: false },
    { ...safe(), hasResidencyBlockingWork: true },
    { ...safe(), hasPendingInteractions: true },
    { ...safe(), hasQueuedCommands: true },
  ])("does not interrupt accepted work or draft state", async (facts) => {
    const { pool, deactivate } = fixture(facts);
    const release = await pool.acquireOperation("target");
    await expect(pool.refreshForResume("target")).rejects.toThrow("busy");
    expect(deactivate).not.toHaveBeenCalled();
    release();
  });

  it("rejects a refresh without the request lease or with concurrent operations", async () => {
    const { pool, deactivate } = fixture();
    await expect(pool.refreshForResume("target")).rejects.toThrow("busy");
    const release = await pool.acquireOperation("target");
    const releaseOther = await pool.acquireOperation("target");
    await expect(pool.refreshForResume("target")).rejects.toThrow("busy");
    expect(deactivate).not.toHaveBeenCalled();
    releaseOther();
    release();
  });

  it("blocks concurrent activation until the old App is fully closed", async () => {
    let finish!: () => void;
    const { pool } = fixture(
      safe(),
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const release = await pool.acquireOperation("target");
    const refresh = pool.refreshForResume("target");
    let activated = false;
    const waiter = pool.acquireOperation("target").then((releaseWaiter) => {
      activated = true;
      releaseWaiter();
    });
    await Promise.resolve();
    expect(activated).toBe(false);
    finish();
    await refresh;
    await waiter;
    expect(activated).toBe(true);
    release();
  });

  it("retains a failed close barrier instead of reactivating half-closed resources", async () => {
    const { pool } = fixture(safe(), async () => {
      throw new Error("close failed");
    });
    const release = await pool.acquireOperation("target");
    await expect(pool.refreshForResume("target")).rejects.toThrow("close failed");
    await expect(pool.acquireOperation("target")).rejects.toThrow("close failed");
    release();
  });
});

it("warm automation resume rematerializes the original persisted session with the new MCP config", async () => {
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionId = "sess_automation_refresh" as SessionId;
  const materialized: ZCodeAppOptions[] = [];
  const closed = vi.fn(async () => {});
  const server = new ZCodeProtocolAgentServer({
    cwd: process.cwd(),
    sessionStore: store,
    createZCodeApp: (options) => {
      materialized.push(options);
      const app = createFakeApp(options, { close: closed });
      Object.assign(app.runtime, { beginShutdown: () => {} });
      return app;
    },
  });
  server.setNotificationSink((message) => {
    if (
      "id" in message &&
      "method" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    )
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
      });
  });
  await store.createSession({
    id: sessionId,
    projectID: "project_refresh" as ProjectId,
    slug: "automation-refresh",
    directory: process.cwd(),
    path: process.cwd(),
    title: "Preserved conversation",
    version: "test",
    time: { created: 1, updated: 2 },
  });
  await store.saveMessage({
    id: "msg_original" as MessageId,
    sessionID: sessionId,
    role: "user",
    time: { created: 1 },
    agent: "zcode-agent",
  });
  const resume = (id: string, automation = false) =>
    server.handleMessage({
      id,
      method: zcodeProtocolMethods.sessionResume,
      params: {
        sessionId,
        ...(automation ? { refreshConfiguration: true } : {}),
        mcpServers: [{ name: id, type: "http", url: "https://synthetic.invalid/mcp", headers: [] }],
      },
    });
  try {
    expect(await resume("old")).toHaveProperty("result");
    expect(materialized).toHaveLength(1);
    expect(await resume("ordinary")).toHaveProperty("result");
    expect(materialized).toHaveLength(1);
    expect(await resume("current", true)).toHaveProperty("result");
    expect(materialized).toHaveLength(2);
    expect(closed).toHaveBeenCalledOnce();
    expect(materialized[1]?.sessionId).toBe(sessionId);
    expect(materialized[1]?.runtimeConfig?.mcp?.servers).toHaveProperty("current");
    expect(materialized[1]?.runtimeConfig?.mcp?.servers).not.toHaveProperty("old");
    expect((await store.getSession(sessionId))?.title).toBe("Preserved conversation");
    expect(await store.messages({ sessionID: sessionId })).toHaveLength(1);
    expect(await resume("next", true)).toHaveProperty("result");
    expect(materialized).toHaveLength(3);
    expect(materialized[2]?.runtimeConfig?.mcp?.servers).toHaveProperty("next");
  } finally {
    await server.shutdown();
    store.close();
  }
});
