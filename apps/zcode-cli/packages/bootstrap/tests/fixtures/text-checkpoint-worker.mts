import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { textCheckpointSchema, type SessionId } from "@zcode/contracts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPersistentCommandFacts } from "../../src/zcode-protocol-v4/persistent-command-facts.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "../helpers/registry-backed-test-app.js";

const [action, root, transfer] = process.argv.slice(2);
assert(root && transfer && (action === "source" || action === "target"));
await mkdir(root, { recursive: true });
const events: unknown[] = [];
const logger = {
  info: (_message: string, context: unknown) => events.push(context),
  warn: (_message: string, context: unknown) => events.push(context),
  debug() {},
  error() {},
  child() {
    return this;
  },
};
const store = createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite"), logger });
const checkpoint =
  action === "target"
    ? textCheckpointSchema.parse(JSON.parse(await readFile(transfer, "utf8")))
    : undefined;
if (checkpoint)
  await store.importTextCheckpoint({
    checkpoint,
    target: {
      projectID: "s0-target-project" as never,
      workspaceID: "s0-target-workspace" as never,
      directory: root,
    },
  });
let calls = 0;
let hasOriginalContext = false;
const selection = { providerId: "zai", modelId: "glm-4.6", options: { reasoningLevel: "low" } };
const targetDefault = {
  providerId: "target-provider",
  modelId: "target-model",
  options: { reasoningLevel: "high" },
};
const app = await createRegistryBackedTestApp({
  env: { ZCODE_HOME: root },
  skipUserConfig: true,
  sessionStore: store,
  providerRegistry: createTestProviderRegistry([selection, targetDefault]),
  ...(checkpoint ? { sessionId: checkpoint.session.id as SessionId, resume: true } : {}),
  runtimeConfig: {
    workingDirectory: root,
    mcp: { enabled: false },
    modelSelection: action === "source" ? selection : targetDefault,
  },
  modelExecutor: {
    async generateText(request, execution) {
      calls += 1;
      assert.equal(execution.providerId, selection.providerId);
      assert.equal(execution.modelId, selection.modelId);
      assert.equal(request.options?.reasoningLevel, selection.options.reasoningLevel);
      const context = JSON.stringify(request.messages);
      assert(
        !context.includes("S0_CANCELLED_DRAFT"),
        "terminal input ledger is not executable history",
      );
      hasOriginalContext =
        context.includes("S0_SOURCE_PROMPT") && context.includes("S0_SOURCE_REPLY");
      return {
        finishReason: "stop",
        text: action === "source" ? "S0_SOURCE_REPLY" : "S0_TARGET_REPLY",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  },
});
try {
  if (checkpoint) {
    await app.resume();
    assert.equal(calls, 0, "import/resume must not execute historical input");
    const session = await store.getSession(app.sessionId);
    assert.equal(session?.directory, root);
    assert.equal(session?.workspaceID, "s0-target-workspace");
    assert.equal(session?.permission, undefined);
    assert.deepEqual(app.runtime.getSessionModelSelection(), selection);
    const facts = await loadPersistentCommandFacts(store, app.sessionId);
    assert(facts.transcript?.some((fact) => fact.commandId === "s0-source-command"));
    assert(facts.discarded?.some((fact) => fact.commandId === "s0-cancelled-command"));
  }
  await app.runtime.executeTurn(action === "source" ? "S0_SOURCE_PROMPT" : "S0_TARGET_PROMPT", [], {
    inputId: action === "source" ? "s0-source-command" : "s0-target-command",
  });
  assert.equal(calls, 1);
  if (checkpoint) assert(hasOriginalContext, "fresh target request must contain original context");
  if (action === "source") {
    await store.saveSessionInput({
      id: "s0-cancelled-input",
      sessionID: app.sessionId,
      kind: "prompt",
      delivery: "queue",
      payload: {
        text: "S0_CANCELLED_DRAFT",
        conversationInputIntent: { sourceCommandId: "s0-cancelled-command" },
      },
    });
    await store.settleSessionInput({
      id: "s0-cancelled-input",
      sessionID: app.sessionId,
      status: "cancelled",
      reason: "fault.command.inputCancelled",
    });
  }
  await app.close?.();
  const exported = await store.exportTextCheckpoint({ sessionID: app.sessionId });
  if (action === "source") await writeFile(transfer, JSON.stringify(exported), { mode: 0o600 });
  else await writeFile(`${transfer}.return`, JSON.stringify(exported), { mode: 0o600 });
  assert(
    !JSON.stringify(exported).includes(JSON.stringify(root).slice(1, -1)),
    "source paths must not enter the package",
  );
  process.stdout.write(
    JSON.stringify({
      sessionId: app.sessionId,
      calls,
      hasOriginalContext,
      messages: exported.messages.length,
      events: events.length,
    }),
  );
} finally {
  await app.close?.();
  store.close();
}
