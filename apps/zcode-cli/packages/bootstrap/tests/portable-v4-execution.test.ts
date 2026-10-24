import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ProjectId, SessionId } from "@zcode/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import { loadPersistentCommandFacts } from "../src/zcode-protocol-v4/persistent-command-facts.js";

it("cold-continues native compact/fork context and retains the parent's completed fork command", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-v4-execution-"));
  const sourceRoot = join(root, "source"),
    targetRoot = join(root, "target");
  const source = await createSqliteSessionStore({ dbPath: join(sourceRoot, "sessions.sqlite") });
  let sourceClosed = false;
  let sourceCalls = 0;
  const app = await createRegistryBackedTestApp({
    env: { ZCODE_HOME: sourceRoot },
    skipUserConfig: true,
    sessionStore: source,
    runtimeConfig: { workingDirectory: sourceRoot, mcp: { enabled: false } },
    modelExecutor: {
      async generateText() {
        ++sourceCalls;
        return {
          finishReason: "stop",
          text: sourceCalls === 1 ? "V4_PUBLIC_REPLY" : "V4_COMPACT_MEMORY",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        };
      },
    },
  });
  let target: Awaited<ReturnType<typeof createSqliteSessionStore>> | undefined;
  let restored: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
  try {
    await app.runtime.executeTurn("V4_PUBLIC_PROMPT");
    const messages = await source.messages({ sessionID: app.sessionId });
    const fork = await app.runtime.forkStableConversationAtMessage({
      sourceCommandId: "v4-fork-once",
      goalBoundary: { kind: "none" },
      target: {
        productTurnId: "synthetic-product-turn",
        transcriptTurnId: "synthetic-turn",
        orderedMessageIds: messages.map((message) => String(message.info.id)),
        boundaryMessageId: String(messages.at(-1)!.info.id),
      },
    });
    const child = await source.exportTextCheckpoint({ sessionID: fork.forkedSessionId });
    expect(child.session.parentID).toBe(app.sessionId);
    await app.runtime.executeTurn("/compact");
    const parent = await source.exportTextCheckpoint({ sessionID: app.sessionId });
    expect(parent.version).toBe(4);
    expect(
      parent.messages.some((message) => message.parts.some((part) => part.type === "compaction")),
    ).toBe(true);
    expect(parent.commandFacts?.some((fact) => fact.data.ack.commandId === "v4-fork-once")).toBe(
      true,
    );
    await app.close?.();
    source.close();
    sourceClosed = true;
    await rm(sourceRoot, { recursive: true, force: true });
    target = await createSqliteSessionStore({ dbPath: join(targetRoot, "sessions.sqlite") });
    const destination = { projectID: "synthetic-target" as ProjectId, directory: targetRoot };
    await target.importTextCheckpoint({ checkpoint: parent, target: destination });
    await target.importTextCheckpoint({ checkpoint: child, target: destination });
    expect(
      (await loadPersistentCommandFacts(target, parent.session.id as SessionId)).child,
    ).toContainEqual(expect.objectContaining({ commandId: "v4-fork-once", status: "accepted" }));
    let targetCalls = 0;
    restored = await createRegistryBackedTestApp({
      env: { ZCODE_HOME: targetRoot },
      skipUserConfig: true,
      sessionStore: target,
      sessionId: parent.session.id as SessionId,
      resume: true,
      runtimeConfig: { workingDirectory: targetRoot, mcp: { enabled: false } },
      modelExecutor: {
        async generateText(request) {
          ++targetCalls;
          expect(JSON.stringify(request.messages)).toContain("V4_COMPACT_MEMORY");
          return {
            finishReason: "stop",
            text: "V4_COLD_REPLY",
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          };
        },
      },
    });
    await restored.resume();
    expect(targetCalls).toBe(0);
    await restored.runtime.executeTurn("V4_CONTINUE");
    expect(targetCalls).toBe(1);
  } finally {
    await restored?.close?.();
    target?.close();
    await app.close?.();
    if (!sourceClosed) source.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
