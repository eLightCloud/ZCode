import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createConversationSyncHost } from "#src/session/conversationSyncHost.js";
import { getConversationWorkspaceDir, setDataBaseDir } from "#src/paths.js";
let root: string, index: TaskIndexRepo;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "target-index-"));
  setDataBaseDir(root);
  index = new TaskIndexRepo();
});
afterEach(async () => {
  index.close();
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
});
const management = { titleOverride: "User title", archived: true, pinned: true, deleted: false };
function fixture() {
  const checkpoint = { session: { id: "restored" }, format: "synthetic-only" };
  const dataBase64 = Buffer.from(JSON.stringify(checkpoint)).toString("base64");
  const agent = {
    captureTextCheckpoint: vi.fn(async () => ({
      dataBase64,
      indexProjection: {
        cliFacts: { titleSource: "generated", lastOutcome: "completed", deleted: false },
        meta: {
          taskId: "restored",
          traceId: "restored",
          title: "Native title",
          createdAt: 1,
          updatedAt: 3,
          mode: "build" as const,
          status: "completed" as const,
          model: "synthetic:model",
        },
        searchableText: "searchable body",
      },
    })),
  };
  return {
    agent,
    dataBase64,
    host: createConversationSyncHost({ index, agent }),
    session: "restored",
    isCurrent: () => true,
    management,
  };
}
it("rebuilds the whole native projection and unique user actions, then preserves them on reopen", async () => {
  const value = fixture();
  // Native and PG JSON can have different key orders without changing the version.
  await value.host.rebuildIndex!({
    ...value,
    dataBase64: Buffer.from('{"format":"synthetic-only","session":{"id":"restored"}}').toString(
      "base64",
    ),
  });
  const target = { workspacePath: getConversationWorkspaceDir(), taskId: value.session };
  expect((await index.getTaskMeta(target))?.title).toBe(management.titleOverride);
  expect((await index.getTaskMeta(target))?.workspacePurpose).toBe("conversation");
  expect(
    (
      await index.queryTaskList({
        kind: "archived",
        workspaceScopes: [target],
        sortBy: "updated",
        search: "searchable body",
      })
    ).total,
  ).toBe(1);
  index.close();
  index = new TaskIndexRepo();
  expect(await index.withConversationSyncFacts(target, async (facts) => facts)).toEqual(management);
});
it("rejects unknown legacy facts, changed native data, identity changes and concurrent user actions", async () => {
  const value = fixture();
  await expect(
    value.host.rebuildIndex!({
      ...value,
      management: { titleOverride: null, archived: false, deleted: false },
    }),
  ).rejects.toThrow("unsupported");
  await expect(
    value.host.rebuildIndex!({ ...value, dataBase64: Buffer.from("{}").toString("base64") }),
  ).rejects.toThrow("checkpoint_changed");
  await expect(value.host.rebuildIndex!({ ...value, isCurrent: () => false })).rejects.toThrow(
    "identity_changed",
  );
  const second = new TaskIndexRepo();
  value.agent.captureTextCheckpoint.mockImplementationOnce(async () => {
    await second.applyCliFacts({
      meta: {
        taskId: value.session,
        traceId: "later",
        title: "Local new action",
        workspacePath: getConversationWorkspaceDir(),
        createdAt: 1,
        updatedAt: 4,
        mode: "default",
        workspacePurpose: "conversation",
        provider: "glm",
      },
      titleSource: "custom",
    });
    return {
      dataBase64: value.dataBase64,
      indexProjection: {
        cliFacts: { titleSource: "generated", lastOutcome: "completed", deleted: false },
        meta: {
          taskId: value.session,
          traceId: "restored",
          title: "Native title",
          createdAt: 1,
          updatedAt: 3,
          mode: "build",
          status: "completed",
          model: "synthetic:model",
        },
        searchableText: "body",
      },
    };
  });
  try {
    await expect(value.host.rebuildIndex!({ ...value })).rejects.toThrow("index_exists");
    expect(
      (
        await index.getTaskMeta({
          workspacePath: getConversationWorkspaceDir(),
          taskId: value.session,
        })
      )?.title,
    ).toBe("Local new action");
  } finally {
    second.close();
  }
});
it("ordinary deletion recreates the hidden index without reviving or claiming recovery", async () => {
  const value = fixture();
  await expect(
    value.host.rebuildIndex!({
      ...value,
      dataBase64: Buffer.from("{}").toString("base64"),
      management: { ...management, deleted: true },
    }),
  ).rejects.toThrow("checkpoint_changed");
  await value.host.rebuildIndex!({
    ...value,
    management: { ...management, deleted: true },
  });
  expect(
    await index.listTaskMetas({ workspacePath: getConversationWorkspaceDir(), archived: true }),
  ).toEqual([]);
  expect((await value.host.capture(value.session)).management.deleted).toBe(true);
});

it("does not guess CLI facts when an older capture lacks them", async () => {
  const value = fixture();
  const captured = await value.agent.captureTextCheckpoint();
  Reflect.deleteProperty(captured.indexProjection, "cliFacts");
  value.agent.captureTextCheckpoint.mockResolvedValueOnce(captured);
  await expect(value.host.rebuildIndex!({ ...value })).rejects.toThrow("unsupported");
  expect(
    await index.getTaskMeta({
      workspacePath: getConversationWorkspaceDir(),
      taskId: value.session,
    }),
  ).toBeNull();
});

it("shares capture eligibility with rebuild, including changeSummary and ordinary fork lineage",async()=>{
  const {isConversationSyncMeta}=await import("#src/session/conversationSyncIndex.js");
  const meta={taskId:"qualified",traceId:"trace",title:"Synthetic",createdAt:1,updatedAt:2,mode:"build",workspacePurpose:"conversation",provider:"glm",workspacePath:getConversationWorkspaceDir()} as const;
  expect(isConversationSyncMeta(meta)).toBe(true);
  expect(isConversationSyncMeta({...meta,forkedFromTaskId:"parent"})).toBe(true);
  expect(isConversationSyncMeta({...meta,changeSummary:{summary:"unsupported"}} as never)).toBe(false);
  expect(isConversationSyncMeta({...meta,workspacePurpose:undefined})).toBe(false);
  expect(isConversationSyncMeta({...meta,workspacePurpose:undefined},true)).toBe(true);
});
