import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createConversationSyncHost } from "#src/session/conversationSyncHost.js";
import { createFileService } from "#src/file/fileService.js";
import { setDataBaseDir, getConversationWorkspaceDir } from "#src/paths.js";
let root: string, index: TaskIndexRepo;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-sync-host-"));
  setDataBaseDir(root);
  index = new TaskIndexRepo();
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
  await index.syncTaskMeta({ meta: original });
  await index.syncTaskMeta({ meta: meta("directory", join(root, "project")) });
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque-checkpoint" })) };
  const host = createConversationSyncHost({ index, agent });
  expect(await host.enumerate()).toEqual(["conversation"]);
  await index.updateTaskState({
    ...original,
    patch: { title: "User title", titleOverridden: true, archived: true, pinned: true },
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
  await index.syncTaskMeta({ meta: original });
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
    .updateTaskState({ ...original, patch: { title: "Later", titleOverridden: true } })
    .then(() => {
      changed = true;
    });
  await Promise.resolve();
  expect(changed).toBe(false);
  finish();
  expect((await capture).management.titleOverride).toBeNull();
  await rename;
  await index.syncTaskMeta({ meta: { ...meta("scheduled"), cronAutomationId: "cron" } });
  await expect(host.capture("scheduled")).rejects.toThrow("ineligible");
  await index.syncTaskMeta({
    meta: { ...meta("future-class"), workspacePurpose: "future-class" } as never,
  });
  await expect(host.capture("future-class")).rejects.toThrow("unsupported_index");
});
it("rejects a second Host's change-and-revert during capture without holding a database lock", async () => {
  await ensureConversation();
  const original = meta("conversation");
  await index.syncTaskMeta({ meta: original });
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
      patch: { title: "Changed", titleOverridden: true },
    });
    await second.updateTaskState({
      ...original,
      patch: { title: original.title, titleOverridden: false },
    });
    finish();
    await rejected;
  } finally {
    second.close();
  }
});
it("persists native purpose for new rows without relabelling old unknown rows", async () => {
  const old = meta("old-unknown");
  await index.syncTaskMeta({ meta: old });
  await ensureConversation();
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque" })) };
  const host = createConversationSyncHost({ index, agent });
  await expect(host.capture(old.taskId)).rejects.toThrow("unsupported_index");
  await index.syncTaskMeta({ meta: meta("new-conversation") });
  await host.capture("new-conversation");
  index.close();
  index = new TaskIndexRepo();
  await index.syncTaskMeta({ meta: meta("new-conversation"), searchableText: "snapshot refresh" });
  const next = createConversationSyncHost({ index, agent });
  await expect(next.capture("new-conversation")).resolves.toHaveProperty("dataBase64", "opaque");
  await expect(next.capture(old.taskId)).rejects.toThrow("unsupported_index");
});
it("records the application bootstrap declaration before the first snapshot write", async () => {
  index.close();
  index = new TaskIndexRepo(undefined, undefined, "conversation");
  await index.syncTaskMeta({ meta: meta("first-snapshot") });
  const agent = { captureTextCheckpoint: vi.fn(async () => ({ dataBase64: "opaque" })) };
  await expect(
    createConversationSyncHost({ index, agent }).capture("first-snapshot"),
  ).resolves.toHaveProperty("dataBase64", "opaque");
});
