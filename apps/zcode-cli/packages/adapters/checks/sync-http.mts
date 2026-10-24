import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceId } from "@zcode/contracts";
import { NodeHttpClientAdapter } from "@zcode/adapters/http";
import { randomUUID } from "node:crypto";
import type { ConversationSyncStore, SyncScope } from "@zcode/contracts";
import {
  createConversationSyncHttpHandler,
  createConversationSyncHttpClient,
  createConversationSyncWorker,
  createConversationSyncOutbox,
} from "@zcode/adapters/conversation-sync";
import { logger, checkpoint, version } from "./sync-fixture.mjs";

export async function verifyHttp(
  store: ConversationSyncStore,
  scope: SyncScope,
  other: SyncScope,
  checks: string[],
) {
  const tokens = new Map([
    [randomUUID(), scope],
    [randomUUID(), other],
  ]);
  const [token, otherToken] = [...tokens.keys()];
  let sourceQualified = true;
  const handler = createConversationSyncHttpHandler({
    store,
    maxRequestBytes: 4096,
    logger,
    authenticate: async (request) => tokens.get(request.headers.authorization ?? "") ?? null,
    qualify: async (_scope, request) => sourceQualified && request.session !== "directory-project",
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "sync-http-proof-"));
  const outbox = createConversationSyncOutbox(join(root, "sync.sqlite"));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: token, "content-type": "application/json" };
  const request = {
    session: "http-session",
    operation: randomUUID(),
    command: {
      kind: "receive",
      version: { ...version("http-v1"), checkpoint: checkpoint("http-session") },
    },
  };
  try {
    assert.equal((await fetch(base + "/sessions")).status, 401);
    const posted = await fetch(base + "/versions", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    assert.equal(posted.status, 200);
    const receipt = await posted.json();
    assert.equal(receipt.outcome, "saved");
    assert.equal(receipt.state.active, null);
    sourceQualified = false;
    const retry = await fetch(base + "/versions", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), receipt);
    assert.equal(
      (
        await fetch(base + "/versions", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...request, operation: randomUUID() }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/versions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...request,
            command: {
              ...request.command,
              version: { ...request.command.version, id: "different" },
            },
          }),
        })
      ).status,
      409,
    );
    sourceQualified = true;
    checks.push(
      "exact_saved_receipt_remains_recoverable_after_source_qualification_changes_without_accepting_new_input",
    );
    const queried = await fetch(
      base + "/receipt?session=http-session&operation=" + request.operation,
      { headers },
    );
    assert.deepEqual(await queried.json(), receipt);
    const history = await fetch(base + "/version?session=http-session&version=http-v1", {
      headers,
    });
    assert.deepEqual(await history.json(), request.command.version);
    const isolated = await fetch(base + "/version?session=http-session&version=http-v1", {
      headers: { authorization: otherToken },
    });
    assert.equal(await isolated.json(), null);
    const directory = {
      ...request,
      session: "directory-project",
      operation: randomUUID(),
      command: {
        kind: "receive",
        version: { ...version("directory"), checkpoint: checkpoint("directory-project") },
      },
    };
    assert.equal(
      (
        await fetch(base + "/versions", {
          method: "POST",
          headers,
          body: JSON.stringify(directory),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/versions", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...request, scope }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/versions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...request,
            command: {
              kind: "grant",
              revision: 0,
              handoff: "forged",
              checkpoint: "http-v1",
              sourceBarrier: true,
              dependenciesVerified: true,
            },
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/versions", { method: "POST", headers, body: "x".repeat(4097) })).status,
      413,
    );
    const after = await fetch(base + "/state?session=http-session", { headers });
    assert.equal((await after.json()).revision, 1);
    checks.push(
      "real_http_identity_read_without_executor_qualification_no_scope_or_proof_injection",
    );
    checks.push("request_limit_preserves_confirmed_version");
    const client = createConversationSyncHttpClient({
      url: base,
      scope,
      currentScope: () => scope,
      httpClient: new NodeHttpClientAdapter({ env: {} }),
      credential: async () => token,
      timeoutMs: 5000,
      maxResponseBytes: 128_000,
      trace: { traceId: createTraceId() },
      allowLoopbackHttp: true,
    });
    assert.deepEqual(
      await client.version(scope, "http-session", "http-v1"),
      request.command.version,
    );
    await assert.rejects(client.state(other, "http-session"), { code: "scope" });
    await assert.rejects(
      client.execute(scope, {
        session: "http-session",
        operation: randomUUID(),
        command: {
          kind: "cancel",
          handoff: "forged",
        },
      }),
      { code: "blocked" },
    );
    let loseAck = true;
    const worker = createConversationSyncWorker({
      scope,
      currentScope: () => scope,
      outbox,
      logger,
      center: {
        ...client,
        execute: async (targetScope, input) => {
          const result = await client.execute(targetScope, input);
          if (loseAck) {
            loseAck = false;
            throw new Error("synthetic_ack_loss");
          }
          return result;
        },
      },
      source: {
        changes: async (after) => ({
          cursor: 1,
          items:
            after === 0
              ? [
                  {
                    workspacePurpose: "conversation",
                    hasLocalDirectory: false,
                    session: "worker-http",
                    version: {
                      ...version("worker-v1"),
                      checkpoint: checkpoint("worker-http"),
                    },
                  },
                ]
              : [],
        }),
      },
    });
    await assert.rejects(worker.reconcile(), /synthetic_ack_loss/);
    const pendingOperation = outbox.pending(scope)[0].operation;
    assert.equal(outbox.watermark(scope, "worker-http"), null);
    await worker.reconcile();
    assert.equal(outbox.pending(scope).length, 0);
    assert.equal(outbox.watermark(scope, "worker-http")!.operation, pendingOperation);
    assert.equal((await client.state(scope, "worker-http"))!.revision, 1);
    checks.push("native_HTTP_client_worker_lost_ACK_retains_exact_operation_and_then_catches_up");
  } finally {
    outbox.close();
    await rm(root, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
