import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import {
  createConversationSyncHost,
  resolveConversationSyncTarget,
} from "#src/session/conversationSyncHost.js";
import { createProjectService } from "#src/project/index.js";
import { createFileService } from "#src/file/fileService.js";
import { setDataBaseDir, getConversationWorkspaceDir } from "#src/paths.js";
let root: string, index: TaskIndexRepo;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-sync-host-"));
  setDataBaseDir(root);
  index = new TaskIndexRepo();
});
it("never chooses a default or arbitrary directory when the session mapping is ambiguous", async () => {
  const listConversationSyncTargets = vi.fn(async () => [
    { taskId: "same-session", workspacePath: "/draft-a" },
    { taskId: "same-session", workspacePath: "/draft-b" },
  ]);
  await expect(
    resolveConversationSyncTarget({ listConversationSyncTargets }, "same-session"),
  ).rejects.toThrow("conversation_sync_ambiguous_index");
  await expect(
    resolveConversationSyncTarget({ listConversationSyncTargets }, "new-session"),
  ).resolves.toEqual({
    taskId: "new-session",
    workspacePath: getConversationWorkspaceDir(),
  });
});
afterEach(async () => {
  index.close();
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
});
function meta(taskId: string, workspacePath = getConversationWorkspaceDir()) {
  return {
    taskId,
    traceId: `trace:${taskId}`,
    workspacePath,
    title: "Original title",
    provider: "glm" as const,
    mode: "default" as const,
    createdAt: 10,
    updatedAt: 20,
  };
}
async function ensureConversation() {
  return createFileService({
    onConversationWorkspaceEnsured: () => index.registerConversationWorkspace(),
  }).ensureConversationWorkspace();
}
it("selects only the trusted conversation workspace and preserves unique rename/archive/delete actions", async () => {
  await ensureConversation();
  const original = meta("conversation");
  await index.applyCliFacts({ meta: original });
  await index.applyCliFacts({ meta: meta("directory", join(root, "project")) });
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque-checkpoint" })) };
  const host = createConversationSyncHost({ index, agent });
  expect(await host.enumerate()).toEqual(["conversation"]);
  await index.applyCliFacts({ meta: { ...original, title: "User title" }, titleSource: "custom" });
  await index.updateTaskState({
    ...original,
    patch: { archived: true, pinned: true },
  });
  expect(await host.capture("conversation")).toEqual({
    dataBase64: "opaque-checkpoint",
    management: { titleOverride: "User title", archived: true, deleted: false, pinned: true },
  });
  await index.deleteArchivedTask(original);
  agent.captureTextCheckpoint.mockClear();
  expect((await host.capture("conversation")).management.deleted).toBe(true);
  expect(agent.captureTextCheckpoint).not.toHaveBeenCalled();
  index.close();
  index = new TaskIndexRepo();
  expect(
    (await createConversationSyncHost({ index, agent }).capture("conversation")).management.deleted,
  ).toBe(true);
});
it("serializes Host actions around the native export and refuses automation metadata", async () => {
  await ensureConversation();
  const original = meta("conversation");
  await index.applyCliFacts({ meta: original });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = vi.fn();
  const host = createConversationSyncHost({
    index,
    agent: {
      captureTextCheckpoint: async () => {
        entered();
        await pending;
        return { dataBase64: "opaque" };
      },
    },
  });
  const capture = host.capture("conversation");
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  let changed = false;
  const rename = index
    .applyCliFacts({ meta: { ...original, title: "Later" }, titleSource: "custom" })
    .then(() => {
      changed = true;
    });
  await Promise.resolve();
  expect(changed).toBe(false);
  finish();
  expect((await capture).management.titleOverride).toBeNull();
  await rename;
  await index.applyCliFacts({ meta: { ...meta("scheduled"), cronAutomationId: "cron" } });
  await expect(host.capture("scheduled")).rejects.toThrow("ineligible");
  await index.applyCliFacts({
    meta: { ...meta("future-class"), workspacePurpose: "future-class" } as never,
  });
  await expect(host.capture("future-class")).rejects.toThrow("unsupported_index");
});
it("rejects a second Host's change-and-revert during capture without holding a database lock", async () => {
  await ensureConversation();
  const original = meta("conversation");
  await index.applyCliFacts({ meta: original });
  const second = new TaskIndexRepo();
  await second.ensureReady();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = vi.fn();
  const host = createConversationSyncHost({
    index,
    agent: {
      captureTextCheckpoint: async () => {
        entered();
        await pending;
        return { dataBase64: "opaque" };
      },
    },
  });
  try {
    const capture = host.capture("conversation");
    const rejected = expect(capture).rejects.toThrow("index_changed");
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    await second.updateTaskState({
      ...original,
      patch: { pinned: true },
    });
    await second.updateTaskState({
      ...original,
      patch: { pinned: false },
    });
    finish();
    await rejected;
  } finally {
    second.close();
  }
});
it("persists native purpose for new rows without relabelling old unknown rows", async () => {
  const old = meta("old-unknown");
  await index.applyCliFacts({ meta: old });
  await ensureConversation();
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque" })) };
  const host = createConversationSyncHost({ index, agent });
  await expect(host.capture(old.taskId)).rejects.toThrow("unsupported_index");
  await index.applyCliFacts({ meta: meta("new-conversation") });
  await host.capture("new-conversation");
  index.close();
  index = new TaskIndexRepo();
  await index.applyCliFacts({ meta: meta("new-conversation") });
  const next = createConversationSyncHost({ index, agent });
  await expect(next.capture("new-conversation")).resolves.toHaveProperty("dataBase64", "opaque");
  await expect(next.capture(old.taskId)).rejects.toThrow("unsupported_index");
});
it("records the application bootstrap declaration before the first snapshot write", async () => {
  index.close();
  index = new TaskIndexRepo(undefined, undefined, undefined, undefined, "conversation");
  await index.applyCliFacts({ meta: meta("first-snapshot") });
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque" })) };
  await expect(
    createConversationSyncHost({ index, agent }).capture("first-snapshot"),
  ).resolves.toHaveProperty("dataBase64", "opaque");
});

it("requires exact legacy preview before marking purpose and rejects directory or changed-summary metadata", async () => {
  const task = meta("legacy");
  await index.applyCliFacts({ meta: task });
  const host = createConversationSyncHost({
    index,
    agent: {
      captureTextCheckpoint: async () => ({
        dataBase64: "opaque",
        originCommandId: "original-command",
      }),
    },
  });
  const preview = await host.legacy!(task.taskId);
  expect(preview.originCommandId).toBe("original-command");
  await expect(
    host.legacy!(task.taskId, true, { ...preview, dataBase64: "changed" }),
  ).rejects.toThrow("legacy_changed");
  expect((await index.getTaskMeta(task))?.workspacePurpose).toBeUndefined();
  await host.legacy!(task.taskId, true, preview);
  expect((await index.getTaskMeta(task))?.workspacePurpose).toBe("conversation");
  await index.applyCliFacts({
    meta: { ...task, taskId: "summary", changeSummary: { summary: "unsupported" } } as never,
  });
  await expect(host.legacy!("summary")).rejects.toThrow("unsupported_index");
  await index.applyCliFacts({ meta: meta("directory", join(root, "project")) });
  await expect(host.legacy!("directory")).rejects.toThrow("ineligible");
});

it("registers each native no-project draft before its first metadata write and captures its exact path", async () => {
  const service = createProjectService({
    workspaceDirectory: dirname(getConversationWorkspaceDir()),
    repository: () => index.getProjectRepository(),
    registerConversationWorkspace: (path) => index.registerConversationWorkspace(path),
  });
  const prepared = await service.prepareSession({
    draftId: "4022e859-2b0a-4588-9081-af8d6c43c411",
  });
  const item = meta("new-draft", prepared.workspacePath);
  await index.applyCliFacts({ meta: item });
  expect((await index.getTaskMeta(item))?.workspacePurpose).toBe("conversation");
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque" })) };
  const host = createConversationSyncHost({ index, agent });
  expect(await host.enumerate()).toEqual([item.taskId]);
  await host.capture(item.taskId);
  expect(agent.captureTextCheckpoint).toHaveBeenCalledWith({
    workspacePath: prepared.workspacePath,
    sessionId: item.taskId,
  });
  const project = await service.saveProject({
    name: "Explicit project",
    roots: [prepared.workspacePath],
  });
  await service.moveTask({
    task: { workspacePath: prepared.workspacePath, taskId: item.taskId },
    projectId: project.id,
  });
  expect(await host.enumerate()).toEqual([]);
});
it("requires explicit attribution for an existing unknown internal draft", async () => {
  const path = join(
    dirname(getConversationWorkspaceDir()),
    "draft-4022e859-2b0a-4588-9081-af8d6c43c412",
  );
  const item = meta("old-draft", path);
  await index.applyCliFacts({ meta: item });
  const host = createConversationSyncHost({
    index,
    agent: { captureTextCheckpoint: async () => ({ dataBase64: "opaque" }) },
  });
  expect(await host.enumerate()).toContain(item.taskId);
  await expect(host.capture(item.taskId)).rejects.toThrow("unsupported_index");
  const preview = await host.legacy!(item.taskId);
  expect((await index.getTaskMeta(item))?.workspacePurpose).toBeUndefined();
  await host.legacy!(item.taskId, true, preview);
  await expect(host.capture(item.taskId)).resolves.toHaveProperty("dataBase64", "opaque");
  await expect(index.registerConversationWorkspace(join(root, "user-project"))).rejects.toThrow(
    "ineligible",
  );
});
it("keeps native uniqueness protection across internal draft directories", async () => {
  const paths = ["1", "2"].map((suffix) =>
    join(
      dirname(getConversationWorkspaceDir()),
      "draft-4022e859-2b0a-4588-9081-af8d6c43c41" + suffix,
    ),
  );
  for (const path of paths) await index.registerConversationWorkspace(path);
  await index.applyCliFacts({ meta: meta("duplicate", paths[0]) });
  await expect(index.applyCliFacts({ meta: meta("duplicate", paths[1]) })).rejects.toThrow(
    "UNIQUE",
  );
});
