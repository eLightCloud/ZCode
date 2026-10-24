import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationSyncError, type ConversationSyncStore, type Logger } from "@zcode/contracts";
import { createConversationSyncOutbox, receiveOperation } from "../src/conversation-sync/outbox.js";
import { createConversationSyncWorker } from "../src/conversation-sync/worker.js";
import { digest } from "../src/conversation-sync/canonical.js";
import { initialState } from "../src/conversation-sync/transitions.js";

it.each(["limit", "invalid", "conflict", "blocked", "stale", "not_found"] as const)(
  "isolates %s per session while acknowledging other sessions",
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), "sync-worker-limit-"));
    const outbox = createConversationSyncOutbox(join(root, "outbox.sqlite"));
    const scope = { tenant: randomUUID(), subject: randomUUID() };
    const requests = ["limited", "limited", "other"].map((session, index) =>
      receiveOperation(session, {
        id: "version-" + index,
        parent: index === 1 ? "version-0" : null,
        location: "desktop",
        generation: 0,
        checkpoint: null,
      }),
    );
    for (const request of requests) outbox.stage(scope, request);
    const execute = vi.fn<ConversationSyncStore["execute"]>(async (_scope, request) => {
      if (request.session === "limited") throw new ConversationSyncError(code);
      return {
        operation: request.operation,
        session: request.session,
        fingerprint: digest(request.command),
        outcome: "saved",
        state: initialState(),
      };
    });
    const unconfirmed = vi.fn();
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return logger;
      },
    };
    const worker = createConversationSyncWorker({
      scope,
      outbox,
      currentScope: () => scope,
      source: { changes: async (after) => ({ cursor: after + 1, items: [] }) },
      center: { execute } as unknown as ConversationSyncStore,
      logger,
      unconfirmed,
    });
    try {
      await expect(worker.reconcile()).rejects.toMatchObject({ code });
      expect(execute.mock.calls.map(([, request]) => request.session)).toEqual([
        "limited",
        "other",
      ]);
      expect(unconfirmed).toHaveBeenCalledExactlyOnceWith("limited", code);
      expect(outbox.pending(scope)).toEqual(requests.slice(0, 2));
      expect(outbox.watermark(scope, "other")?.operation).toBe(requests[2]!.operation);
      expect(outbox.savedVersion(scope, "other")).toBe("version-2");
      execute.mockClear();
      await expect(worker.reconcile()).rejects.toMatchObject({ code });
      expect(execute.mock.calls).toHaveLength(code === "limit" ? 1 : 0);
      if (code !== "limit") {
        outbox.retry(scope, "limited");
        await expect(worker.reconcile()).rejects.toMatchObject({ code });
        expect(execute.mock.calls[0]?.[1].operation).toBe(requests[0]!.operation);
      }
    } finally {
      outbox.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
