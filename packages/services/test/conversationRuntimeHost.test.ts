import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ConversationRuntimeError,
  type ConversationRuntimePort,
  type ConversationRuntimeResult,
} from "@zcode/shared";
import { setDataBaseDir, getConversationWorkspaceDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createFileService } from "#src/file/fileService.js";
import { createConversationRuntimeHost } from "#src/session/conversation-continuation-host/index.js";
let root: string, index: TaskIndexRepo;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "continuation-index-"));
  setDataBaseDir(root);
  index = new TaskIndexRepo();
});
afterEach(async () => {
  index.close();
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
});
const session = "session-1",
  old = "16f5cdab-04e3-45c5-9237-c58e16ac683a",
  operation = "ed6dc9ad-17b0-4f67-a90f-2ebf5500dd96";
async function seed() {
  await index.applyCliFacts({
    meta: {
      taskId: session,
      traceId: "synthetic",
      workspacePath: getConversationWorkspaceDir(),
      workspacePurpose: "conversation",
      title: "Original",
      createdAt: 1,
      updatedAt: 2,
      mode: "build",
      status: "completed",
    },
  });
}
function result(
  state: ConversationRuntimeResult["state"],
  op = operation,
): ConversationRuntimeResult {
  return {
    session,
    operation: op,
    state,
    generation: 1,
    version: "version-1",
    digest: null,
  };
}
it("recovers an index-only close failure and leaves unrelated old guard ownership intact", async () => {
  await seed();
  let current: ConversationRuntimeResult | undefined;
  const runtime: ConversationRuntimePort = {
    async control(input) {
      if (input.kind === "read") {
        if (!current) throw new ConversationRuntimeError("not_found");
        return current;
      }
      if (input.kind === "close") throw new ConversationRuntimeError("unavailable");
      current = result("cancelled");
      return current;
    },
  };
  const host = createConversationRuntimeHost({
    runtime,
    index,
    agent: { captureTextCheckpoint: vi.fn() },
  });
  await expect(host.control({ kind: "close", session, operation })).rejects.toThrow("unavailable");
  await expect(
    index.updateTaskState({
      taskId: session,
      workspacePath: getConversationWorkspaceDir(),
      patch: { pinned: true },
    }),
  ).rejects.toThrow("admission_closed");
  await host.control({ kind: "cancel", session, operation });
  await index.updateTaskState({
    taskId: session,
    workspacePath: getConversationWorkspaceDir(),
    patch: { pinned: true },
  });
  await index.controlConversationIndexBarrier({
    taskId: session,
    workspacePath: getConversationWorkspaceDir(),
    operation: old,
    hold: true,
  });
  await index.controlConversationIndexBarrier({
    taskId: session,
    workspacePath: getConversationWorkspaceDir(),
    operation,
    hold: false,
  });
  await expect(
    index.updateTaskState({
      taskId: session,
      workspacePath: getConversationWorkspaceDir(),
      patch: { pinned: false },
    }),
  ).rejects.toThrow("admission_closed");
});
it("does not rebuild an index or re-adopt after activation ACK loss and subsequent user edits", async () => {
  await seed();
  const capture = vi.fn(),
    adopt = vi.fn();
  const runtime: ConversationRuntimePort = {
    control: async () => result("active"),
  };
  const host = createConversationRuntimeHost({
    runtime,
    index,
    agent: { captureTextCheckpoint: capture },
    beforeActivate: adopt,
  });
  const meta = await index.getTaskMeta({
    taskId: session,
    workspacePath: getConversationWorkspaceDir(),
  });
  if (!meta) throw new Error("fixture native facts missing");
  // After upstream title ownership migration, a real rename is a CLI fact.
  await index.applyCliFacts({
    meta: { ...meta, title: "New user title" },
    titleSource: "custom",
  });
  await host.control({ kind: "apply", session, operation });
  await host.control({
    kind: "activate",
    session,
    operation,
    version: "version-1",
    generation: 1,
  });
  expect(capture).not.toHaveBeenCalled();
  expect(adopt).not.toHaveBeenCalled();
  expect(
    (
      await index.getTaskMeta({
        taskId: session,
        workspacePath: getConversationWorkspaceDir(),
      })
    )?.title,
  ).toBe("New user title");
});

it("allows the activation owner to read its persistent guard during verification", async () => {
  await seed();
  let current = result("applied");
  const runtime: ConversationRuntimePort = {
    async control(input) {
      if (input.kind === "activate") current = result("active");
      return current;
    },
  };
  let host: ConversationRuntimePort;
  const verify = vi.fn(async () => {
    expect((await host.control({ kind: "read", session, operation })).state).toBe("applied");
  });
  host = createConversationRuntimeHost({
    runtime,
    index,
    agent: { captureTextCheckpoint: vi.fn() },
    beforeActivate: verify,
  });
  expect(
    (
      await host.control({
        kind: "activate",
        session,
        operation,
        version: "version-1",
        generation: 1,
      })
    ).state,
  ).toBe("active");
  expect(verify).toHaveBeenCalledTimes(1);
});

it("creates a fresh target namespace through the existing File owner before private Core access", async () => {
  const files = createFileService({
    onConversationWorkspaceEnsured: () => index.registerConversationWorkspace(),
  });
  const runtime: ConversationRuntimePort = {
    async control() {
      expect((await stat(getConversationWorkspaceDir())).isDirectory()).toBe(true);
      return result("closed");
    },
  };
  const host = createConversationRuntimeHost({
    runtime,
    index,
    agent: { captureTextCheckpoint: vi.fn() },
    prepareWorkspace: () => files.ensureConversationWorkspace(),
  });
  expect((await host.control({ kind: "read", session, operation })).state).toBe("closed");
});

it("remote native creation uses only the explicitly registered conversation namespace", async () => {
  index.close();
  index = new TaskIndexRepo(undefined, "remote:server:conversation");
  const task = {
    taskId: "native-new",
    workspacePath: getConversationWorkspaceDir(),
  };
  const unregistered = await index.getProjectRepository();
  expect(() => unregistered.reserveCreatedTask({ task, projectId: null })).toThrow(
    "project.remote-project-required",
  );
  await index.registerConversationWorkspace();
  const registered = await index.getProjectRepository();
  expect(registered.reserveCreatedTask({ task, projectId: null })).toMatchObject({
    projectId: null,
    additionalDirectories: [],
  });
  expect(registered.resolveSessionDirectories(task).workspacePath).toBe(task.workspacePath);
  // 上游先预留空行，再交 CLI 事实；空预留不能被误当成未知来源的旧会话。
  await index.applyCliFacts({
    meta: {
      ...task,
      traceId: "synthetic",
      title: "Native new",
      createdAt: 1,
      updatedAt: 2,
      provider: "glm",
      mode: "build",
      status: "completed",
    },
  });
  await expect(index.withConversationSyncFacts(task, async (facts) => facts)).resolves.toEqual({
    titleOverride: null,
    archived: false,
    deleted: false,
    pinned: false,
  });
  expect(() =>
    registered.reserveCreatedTask({
      task: { taskId: "other", workspacePath: join(root, "user-project") },
      projectId: null,
    }),
  ).toThrow("project.remote-project-required");
});
