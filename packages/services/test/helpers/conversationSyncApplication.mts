/** Synthetic integration fixture. Native stores/Host/center use their real implementations. */
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createConversationSyncStore,
  createConversationSyncPolicyStore,
  createConversationSyncGateway,
  migrateConversationSync,
} from "@zcode/adapters/conversation-sync";
import type { ProjectId, SessionId } from "@zcode/contracts";
import { textCheckpointSchema } from "@zcode/contracts";
import { TaskIndexRepo } from "../../src/session/taskIndexRepo.js";
import { createConversationSyncHost } from "../../src/session/conversationSyncHost.js";
import {
  setDataBaseDir,
  getConversationWorkspaceDir,
  getTasksIndexDatabasePath,
} from "../../src/paths.js";
import { createFileService } from "../../src/file/fileService.js";
import type { IZCodeAgentService } from "../../src/zcode-agent/zcodeAgent.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (config.syntheticOnly !== true || config.host !== "127.0.0.1")
  throw new Error("owned_fixture_required");
const owner = new pg.Pool({
  host: config.host,
  port: config.port,
  user: "postgres",
  password: config.password,
});
await migrateConversationSync(owner);
await owner.query("select set_config('sync_fixture.password',$1,false)", [config.runtimePassword]);
await owner.query(
  `do $$ begin execute format('create role sync_application_fixture login password %L nosuperuser nobypassrls', current_setting('sync_fixture.password')); end $$`,
);
await owner.query("grant zcode_sync_runtime to sync_application_fixture");
await owner.query(
  `do $$ begin execute format('create role sync_application_configuration login password %L nosuperuser nobypassrls', current_setting('sync_fixture.password')); end $$`,
);
await owner.query("grant zcode_sync_configurator to sync_application_configuration");
const pool = new pg.Pool({
  host: config.host,
  port: config.port,
  database: "postgres",
  user: "sync_application_fixture",
  password: config.runtimePassword,
});
const configurationPool = new pg.Pool({
  host: config.host,
  port: config.port,
  database: "postgres",
  user: "sync_application_configuration",
  password: config.runtimePassword,
});
const events: object[] = [];
const log = {
  info: (_message: string, fields?: object) => {
    events.push(fields ?? {});
  },
  warn: (_message: string, fields?: object) => {
    events.push(fields ?? {});
  },
  debug() {},
  error() {},
  child() {
    return log;
  },
};
const configuration = createConversationSyncPolicyStore({
  pool: configurationPool,
  logger: log,
});
const previous = await configuration.read();
await configuration.update(previous.revision, {
  maxCheckpointBytes: 128000,
  maxSubjectBytes: 4000000,
  maxVersionsPerSession: 100,
});
const store = createConversationSyncStore({
  pool,
  policy: "managed",
  logger: log,
});
const gateway = createConversationSyncGateway({
  store,
  proof: config.centerProof,
  maxRequestBytes: 256000,
  logger: log,
});
setDataBaseDir(config.root);
const index = new TaskIndexRepo(undefined, undefined, undefined, undefined, "conversation");
await createFileService({
  onConversationWorkspaceEnsured: () => index.registerConversationWorkspace(),
}).ensureConversationWorkspace();
const source = await createSqliteSessionStore({
  dbPath: join(config.root, "source.sqlite"),
});
let captures = 0;
const agent = {
  // This fixture is explicitly cold: no runtime or writer is created. The real
  // session/textCheckpoint admission barrier has separate protocol regression tests.
  async captureTextCheckpoint(params) {
    ++captures;
    const value = await source.exportTextCheckpoint!({
      sessionID: params.sessionId as SessionId,
    });
    const stored = await source.getSession(params.sessionId as SessionId);
    // 上游 CLI 独占标题和删除事实；夹具也必须从真实 store 捕获，不能由 Host 补造。
    if (!stored || (stored.titleSource !== "generated" && stored.titleSource !== "custom"))
      throw new Error("fixture_cli_facts_missing");
    return {
      dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
      // Synthetic cold projection; the packaged test uses the real native projector.
      indexProjection: {
        meta: {
          taskId: value.session.id,
          traceId: "trace:" + value.session.id,
          title: value.session.title,
          mode: "build",
          status: "completed",
          model: "synthetic:model",
          createdAt: value.session.time.created,
          updatedAt: value.session.time.updated,
        },
        cliFacts: {
          titleSource: stored.titleSource,
          lastOutcome: stored.lastOutcome,
          deleted: stored.time.deleted != null,
        },
        searchableText: value.messages
          .flatMap((message) =>
            message.parts.filter((part) => part.type === "text").map((part) => part.text),
          )
          .join("\n"),
      },
    };
  },
};
let conversations = createConversationSyncHost({
  index,
  agent: agent as unknown as IZCodeAgentService,
});
const credentialValues = new Map<string, string>();
const credentials = {
  load: async (key: string) => credentialValues.get(key) ?? null,
  save: async (key: string, value: string) => {
    credentialValues.set(key, value);
  },
  delete: async (key: string) => {
    credentialValues.delete(key);
  },
};
const { createConversationHost } = await import(pathToFileURL(config.hostModule).href);
let host = await createConversationHost({
  conversations,
  credentials,
  storageRoot: config.root,
  api: config.api,
  logger: log,
});
async function seed(session: string, command: string) {
  const intent = {
    sourceCommandId: command,
    queueItemId: "queue_" + command,
    clientId: "fixture",
    kind: "sendText",
    text: "SYNTHETIC_APP_PRIVATE_TEXT",
    attachments: [],
    modelSelection: { providerId: "synthetic", modelId: "model" },
    mode: "build",
    planEnabled: false,
    delivery: { requested: "startNow", admitted: "startNow" },
    order: { admissionSeq: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: "drained" },
    admittedAt: 1,
  };
  const checkpoint = textCheckpointSchema.parse({
    format: "zcode.text-checkpoint",
    version: 2,
    session: {
      id: session,
      slug: session,
      title: "Synthetic original",
      version: "1",
      time: { created: 1, updated: 2 },
    },
    modelSelection: { providerId: "synthetic", modelId: "model" },
    modelSelectionEntryId: "entry-" + session,
    messages: [
      {
        info: {
          id: "user-" + session,
          role: "user",
          agent: "build",
          time: { created: 1 },
          anchor: { sourceCommandId: command },
          metadata: {
            conversationInputIntent: intent,
            inputClientId: "fixture",
          },
        },
        parts: [
          {
            id: "user-part-" + session,
            type: "text",
            text: "SYNTHETIC_APP_PRIVATE_TEXT",
          },
        ],
      },
      {
        info: {
          id: "assistant-" + session,
          role: "assistant",
          parentID: "user-" + session,
          agent: "build",
          mode: "build",
          time: { created: 1, completed: 2 },
          finish: "stop",
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "assistant-part-" + session,
            type: "text",
            text: "Synthetic response",
          },
        ],
      },
    ],
    inputs: [],
  });
  await source.importTextCheckpoint!({
    checkpoint,
    target: {
      projectID: "source" as ProjectId,
      directory: getConversationWorkspaceDir(),
    },
  });
  const stored = await source.updateSession({
    id: session as SessionId,
    titleSource: "generated",
    lastOutcome: "completed",
    timeUpdated: 2,
  });
  await index.applyCliFacts({
    titleSource: stored.titleSource,
    lastOutcome: stored.lastOutcome,
    deleted: stored.time.deleted != null,
    meta: {
      taskId: session,
      traceId: "trace:" + session,
      workspacePath: getConversationWorkspaceDir(),
      provider: "glm",
      title: checkpoint.session.title,
      mode: "default",
      createdAt: 1,
      updatedAt: 2,
    },
  });
}
const server = createServer(async (request, response) => {
  if (!request.url?.startsWith("/fixture/")) {
    await gateway(request, response);
    return;
  }
  if (request.headers["x-fixture-proof"] !== config.controlProof) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result: unknown;
    if (input.action === "seed") {
      await seed(input.session, input.command);
      result = { seeded: true };
    } else if (input.action === "captures") result = { captures };
    else if (input.action === "index")
      result = {
        meta: await index.getTaskMeta({
          workspacePath: getConversationWorkspaceDir(),
          taskId: input.session,
        }),
      };
    else if (input.action === "lose-index") {
      await host.dispose();
      index.close();
      for (const suffix of ["", "-wal", "-shm"])
        await rm(getTasksIndexDatabasePath() + suffix, { force: true });
      conversations = createConversationSyncHost({
        index,
        agent: agent as unknown as IZCodeAgentService,
      });
      host = await createConversationHost({
        conversations,
        credentials,
        storageRoot: config.root,
        api: config.api,
        logger: log,
      });
      result = { projectionRemoved: true };
    } else if (input.action === "call") result = await host.call(input.method, input.input ?? {});
    else if (input.action === "rename") {
      const stored = await source.updateSession({
        id: input.session as SessionId,
        title: "Synthetic renamed",
        titleSource: "custom",
      });
      const meta = await index.getTaskMeta({
        workspacePath: getConversationWorkspaceDir(),
        taskId: input.session,
      });
      if (!meta) throw new Error("fixture_index_missing");
      await index.applyCliFacts({
        meta: { ...meta, title: stored.title, updatedAt: stored.time.updated },
        titleSource: stored.titleSource,
        lastOutcome: stored.lastOutcome,
        deleted: stored.time.deleted != null,
      });
      await index.updateTaskState({
        workspacePath: getConversationWorkspaceDir(),
        taskId: input.session,
        patch: { archived: true },
      });
      result = { renamed: true };
    } else if (input.action === "delete") {
      await index.deleteArchivedTask({
        workspacePath: getConversationWorkspaceDir(),
        taskId: input.session,
      });
      result = { deleted: true };
    } else if (input.action === "restart") {
      await host.dispose();
      host = await createConversationHost({
        conversations,
        credentials,
        storageRoot: config.root,
        api: config.api,
        logger: log,
      });
      result = { reopened: true };
    } else if (input.action === "stop") {
      await host.dispose();
      result = { stopped: true };
    } else if (input.action === "events") result = { events };
    else throw new Error("fixture_action_invalid");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "fixture_rejected" }));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.stdout.write(
  "SYNC_FIXTURE_READY " +
    JSON.stringify({ port: (server.address() as { port: number }).port }) +
    "\n",
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await host.dispose();
  source.close();
  index.close();
  setDataBaseDir(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await configurationPool.end();
  await owner.end();
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
